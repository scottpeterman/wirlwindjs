/**
 * Wirlwind Telemetry — Cisco NX-OS Vendor Driver
 *
 * Extends CiscoIOSDriver with NX-OS–specific overrides:
 *   - CPU: `show processes cpu` (similar to IOS but NX-OS header format varies)
 *   - Memory: `show system resources` → memory_usage_total/used/free (KB)
 *   - Processes: NX-OS `show processes cpu sort` has different column names
 *   - Neighbors: CDP format identical to IOS
 *   - Interface Detail: Mostly identical to IOS
 *
 * NX-OS shares enough with IOS that most of CiscoIOSDriver works
 * as-is. This subclass overrides only the parts that diverge.
 */

import log from 'electron-log';
import type { StateStore } from '../stateStore';
import {
  registerDriver,
  filterCpuProcesses,
  mergeMemoryIntoProcesses,
  postProcessLog,
  normalizeBgpPeers,
  first,
  firstNumeric,
  toFloat,
} from './base';
import { CiscoIOSDriver } from './cisco_ios';
import { parseCiscoLog } from './logParsers';

// ─── Driver ──────────────────────────────────────────────────

export class CiscoNXOSDriver extends CiscoIOSDriver {
  // NX-OS enable mode: no `enable` command needed (login goes
  // straight to exec), but pagination and width still apply.
  postConnectCommands = ['terminal length 0', 'terminal width 511'];

  constructor(vendor: string) {
    super(vendor);
  }

  postProcess(
    collection: string,
    data: Record<string, any>,
    stateStore?: StateStore
  ): Record<string, any> {
    if (collection === 'cpu') {
      // NX-OS CPU normalization — try NX-OS-specific fields first,
      // then fall through to the IOS normalizer for common fields.
      data = CiscoNXOSDriver.normalizeNxosCpu(data);
      data = filterCpuProcesses(data);
      data = mergeMemoryIntoProcesses(data, stateStore);
    } else if (collection === 'memory') {
      data = CiscoNXOSDriver.normalizeNxosMemory(data);
    } else if (collection === 'log') {
      // NX-OS syslog format is close enough to IOS
      if (data._raw) {
        const parsed = parseCiscoLog(data._raw);
        if (parsed.length > 0) {
          data.entries = parsed;
          data._log_source = 'driver';
        } else {
          const lines = data._raw.split('\n').map((l: string) => l.trim()).filter(Boolean);
          lines.reverse();
          data.entries = lines.slice(0, 50).map((line: string) => ({
            timestamp: '',
            facility: '',
            severity: 6,
            mnemonic: 'RAW',
            message: line,
          }));
          data._log_source = 'raw_fallback';
        }
      } else {
        data = postProcessLog(data);
      }
    } else if (collection === 'bgp_summary' && data.peers) {
      data.peers = normalizeBgpPeers(data.peers);
    } else if (collection === 'neighbors' && data.neighbors) {
      // CDP neighbor format is same as IOS
      data.neighbors = CiscoIOSDriver.postProcessNeighbors(data.neighbors);
    } else if (collection === 'interface_detail' && data.interfaces) {
      data.interfaces = CiscoIOSDriver.postProcessInterfaces(data.interfaces);
    }

    return data;
  }

  // ─── CPU ─────────────────────────────────────────────────

  /**
   * Normalize NX-OS CPU fields.
   *
   * NX-OS `show processes cpu` header:
   *   "CPU utilization for five seconds: 3%/1%; one minute: 2%; five minutes: 2%"
   *
   * NX-OS `show system resources`:
   *   "CPU states  :   2.22% user,   1.11% kernel,  96.67% idle"
   *
   * TextFSM fields vary by template — may include:
   *   cpu_5_sec_total, cpu_1_min, cpu_5_min (IOS-style)
   *   cpu_state_user, cpu_state_kernel, cpu_state_idle (system resources style)
   *   cpuid, kernel, user, idle (per-core from `show processes cpu` detailed)
   */
  static normalizeNxosCpu(data: Record<string, any>): Record<string, any> {
    // Try IOS-style fields first (most NX-OS templates use these)
    let total = first(
      data.cpu_5_sec_total,
      data.cpu_5sec,
      data.five_sec_total,
      data.five_sec_cpu
    );

    // If no IOS-style total, try system-resources idle-based calculation
    if (total == null) {
      const idle = first(data.cpu_state_idle, data.idle, data.idle_pct, data.cpu_idle);
      if (idle != null) {
        total = Math.round((100.0 - idle) * 10) / 10;
      }
    }

    // If still null, try user + kernel
    if (total == null) {
      const user = first(data.cpu_state_user, data.user, data.user_pct, data.cpu_usr);
      const kernel = first(data.cpu_state_kernel, data.kernel, data.system_pct, data.cpu_sys);
      if (user != null) {
        total = Math.round((user + (kernel ?? 0)) * 10) / 10;
      }
    }

    if (total != null) {
      data.five_sec_total = total;
    }

    // One-minute and five-minute
    const oneMin = first(data.cpu_1_min, data.cpu_1min, data.one_min);
    const fiveMin = first(data.cpu_5_min, data.cpu_5min, data.five_min);

    if (oneMin != null) data.one_min = oneMin;
    if (fiveMin != null) data.five_min = fiveMin;

    // Fallback: fill missing intervals from total
    if (data.one_min == null && data.five_sec_total != null) {
      data.one_min = data.five_sec_total;
    }
    if (data.five_min == null && data.five_sec_total != null) {
      data.five_min = data.five_sec_total;
    }

    return data;
  }

  // ─── Memory ──────────────────────────────────────────────

  /**
   * Normalize NX-OS memory fields.
   *
   * NX-OS `show system resources`:
   *   "Memory usage:   16399548K total,   7498780K used,   8900768K free"
   *
   * TextFSM fields: memory_usage_total, memory_usage_used, memory_usage_free (in KB)
   * Also accepts: total_kb, used_kb, free_kb, or IOS-style processor_total, etc.
   *
   * NX-OS reports memory in KB — convert to bytes for consistent dashboard display.
   */
  static normalizeNxosMemory(data: Record<string, any>): Record<string, any> {
    // Try NX-OS system resources fields (KB values)
    let totalKb = firstNumeric(
      data,
      'memory_usage_total', 'total_kb', 'mem_total'
    );
    let usedKb = firstNumeric(
      data,
      'memory_usage_used', 'used_kb', 'mem_used'
    );
    const freeKb = firstNumeric(
      data,
      'memory_usage_free', 'free_kb', 'mem_free'
    );

    // Derive used from total - free
    if (usedKb == null && totalKb != null && freeKb != null) {
      usedKb = totalKb - freeKb;
    }

    if (totalKb != null && totalKb > 0 && usedKb != null) {
      data.used_pct = Math.round((usedKb / totalKb) * 1000) / 10;

      // Store in bytes for consistent display formatting
      const totalBytes = totalKb * 1024;
      const usedBytes = usedKb * 1024;
      const freeBytes = freeKb != null ? freeKb * 1024 : (totalKb - usedKb) * 1024;

      data.used = Math.floor(usedBytes);
      data.total = Math.floor(totalBytes);
      data.free = Math.floor(freeBytes);

      // Human-readable display
      if (totalBytes > 1_000_000_000) {
        data.total_display = `${(totalBytes / (1024 ** 3)).toFixed(1)} GB`;
        data.used_display = `${(usedBytes / (1024 ** 3)).toFixed(1)} GB`;
      } else if (totalBytes > 1_000_000) {
        data.total_display = `${(totalBytes / (1024 ** 2)).toFixed(1)} MB`;
        data.used_display = `${(usedBytes / (1024 ** 2)).toFixed(1)} MB`;
      } else {
        data.total_display = `${(totalBytes / 1024).toFixed(1)} KB`;
        data.used_display = `${(usedBytes / 1024).toFixed(1)} KB`;
      }

      return data;
    }

    // Fallback to IOS-style byte-based fields (processor_total, etc.)
    return CiscoIOSDriver.normalizeMemory(data);
  }
}

// ─── Register ────────────────────────────────────────────────

registerDriver('cisco_nxos', CiscoNXOSDriver);