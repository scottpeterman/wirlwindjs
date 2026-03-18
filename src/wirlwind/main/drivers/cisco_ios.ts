/**
 * Wirlwind Telemetry — Cisco IOS / IOS-XE Vendor Driver
 *
 * Handles IOS-specific field normalization:
 *   - CPU: `show processes cpu sorted` → five_sec_total / one_min / five_min
 *   - Memory: processor total/used/free (bytes) → used_pct
 *   - Processes: Cisco PID/runtime/5sec/1min/5min rows → dashboard format
 *   - Neighbors: CDP/LLDP fields → dashboard neighbor graph format
 *   - Interface Detail: bandwidth/rate/error normalization
 *
 * Registered for both 'cisco_ios' and 'cisco_ios_xe'.
 * IOS-XE uses the same CLI output format as classic IOS for all
 * collections this driver handles.
 */

import log from 'electron-log';
import type { StateStore } from '../stateStore';
import {
  type VendorDriver,
  registerDriver,
  BaseDriver,
  postProcessLog,
  normalizeBgpPeers,
  filterCpuProcesses,
  mergeMemoryIntoProcesses,
  first,
  firstNumeric,
  toFloat,
  toInt,
  parseRateToBps,
  BW_PATTERN,
} from './base';
import { parseCiscoLog } from './logParsers';

// ─── Interface name abbreviations for graph labels ───────────

const INTF_SHORT: Record<string, string> = {
  GigabitEthernet: 'Gi',
  TenGigabitEthernet: 'Te',
  TwentyFiveGigE: 'Twe',
  FortyGigabitEthernet: 'Fo',
  HundredGigE: 'Hu',
  FastEthernet: 'Fa',
  Ethernet: 'Et',
  'Port-channel': 'Po',
  'Port-Channel': 'Po',
  Loopback: 'Lo',
  Vlan: 'Vl',
  Tunnel: 'Tu',
  Serial: 'Se',
  Management: 'Ma',
  AppGigabitEthernet: 'Ap',
  BDI: 'BDI',
  Nve: 'Nve',
};

// ─── Driver ──────────────────────────────────────────────────

export class CiscoIOSDriver extends BaseDriver {
  paginationCommand = 'terminal length 0';
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
      data = CiscoIOSDriver.normalizeCpu(data);
      data = filterCpuProcesses(data);
      data = mergeMemoryIntoProcesses(data, stateStore);
    } else if (collection === 'memory') {
      data = CiscoIOSDriver.normalizeMemory(data);
    } else if (collection === 'log') {
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
      data.neighbors = CiscoIOSDriver.postProcessNeighbors(data.neighbors);
    } else if (collection === 'interface_detail' && data.interfaces) {
      data.interfaces = CiscoIOSDriver.postProcessInterfaces(data.interfaces);
    }

    return data;
  }

  // ─── CPU ─────────────────────────────────────────────────

  /**
   * Normalize Cisco IOS CPU fields.
   *
   * Cisco `show processes cpu` header line:
   *   "CPU utilization for five seconds: 5%/2%; one minute: 6%; five minutes: 5%"
   *
   * TextFSM fields:   cpu_5_sec_total, cpu_5_sec_interrupt, cpu_1_min, cpu_5_min
   * Regex fields:      five_sec_total, five_sec_interrupt, one_min, five_min
   * Normalized fields: five_sec_total, one_min, five_min (what dashboard expects)
   */
  static normalizeCpu(data: Record<string, any>): Record<string, any> {
    // Five-second total CPU
    const fiveSecTotal = first(
      data.cpu_5_sec_total,
      data.cpu_5sec,
      data.five_sec_total,
      data.five_sec_cpu
    );

    // Five-second interrupt CPU
    const fiveSecInt = first(
      data.cpu_5_sec_interrupt,
      data.five_sec_interrupt
    );

    // One-minute CPU
    const oneMin = first(
      data.cpu_1_min,
      data.cpu_1min,
      data.one_min
    );

    // Five-minute CPU
    const fiveMin = first(
      data.cpu_5_min,
      data.cpu_5min,
      data.five_min
    );

    if (fiveSecTotal != null) {
      data.five_sec_total = fiveSecTotal;
    }
    if (fiveSecInt != null) {
      data.five_sec_interrupt = fiveSecInt;
    }
    if (oneMin != null) {
      data.one_min = oneMin;
    }
    if (fiveMin != null) {
      data.five_min = fiveMin;
    }

    // If we somehow only got user+system but not total (unlikely for Cisco)
    if (data.five_sec_total == null) {
      const user = first(data.cpu_usr, data.user_pct);
      const sys = first(data.cpu_sys, data.system_pct);
      if (user != null) {
        data.five_sec_total = Math.round((user + (sys ?? 0)) * 10) / 10;
      }
    }

    // Ensure one_min and five_min have fallbacks
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
   * Normalize Cisco IOS memory fields.
   *
   * Cisco `show processes memory sorted` / `show memory statistics`:
   *   Processor Pool Total: 873977468  Used: 335498564  Free: 538478904
   *
   * TextFSM fields:   processor_total, processor_used, processor_free,
   *                    io_total, io_used, io_free
   * Regex fields:      total_bytes, used_bytes, free_bytes
   *
   * Dashboard expects: used_pct, used, total, free
   */
  static normalizeMemory(data: Record<string, any>): Record<string, any> {
    // Try processor memory first (primary pool), then generic names
    let total = firstNumeric(
      data,
      'processor_total', 'total_bytes', 'mem_total', 'total',
      'memory_total', 'total_kb'
    );
    let used = firstNumeric(
      data,
      'processor_used', 'used_bytes', 'mem_used', 'used',
      'memory_used', 'used_kb'
    );
    const free = firstNumeric(
      data,
      'processor_free', 'free_bytes', 'mem_free', 'free',
      'memory_free', 'free_kb'
    );

    // Derive used from total - free
    if (used == null && total != null && free != null) {
      used = total - free;
    }

    if (total != null && total > 0 && used != null) {
      data.used_pct = Math.round((used / total) * 1000) / 10;
      data.used = Math.floor(used);
      data.total = Math.floor(total);
      data.free = free != null ? Math.floor(free) : Math.floor(total - used);

      // Human-readable display
      if (total > 1_000_000_000) {
        data.total_display = `${(total / (1024 ** 3)).toFixed(1)} GB`;
        data.used_display = `${(used / (1024 ** 3)).toFixed(1)} GB`;
      } else if (total > 1_000_000) {
        data.total_display = `${(total / (1024 ** 2)).toFixed(1)} MB`;
        data.used_display = `${(used / (1024 ** 2)).toFixed(1)} MB`;
      } else if (total > 1_000) {
        data.total_display = `${(total / 1024).toFixed(1)} KB`;
        data.used_display = `${(used / 1024).toFixed(1)} KB`;
      }
    }

    return data;
  }

  // ─── Neighbors ───────────────────────────────────────────

  /**
   * Normalize CDP/LLDP neighbor fields for the dashboard graph.
   *
   * Cisco CDP output fields (TextFSM):
   *   device_id, local_intf, holdtme, capability, platform, remote_intf,
   *   mgmt_ip, software_version
   *
   * Dashboard expects:
   *   device_id (short hostname), platform (clean), local_intf (abbreviated),
   *   remote_intf (abbreviated), capabilities (string)
   */
  static postProcessNeighbors(neighbors: Record<string, any>[]): Record<string, any>[] {
    for (const nbr of neighbors) {
      // ── Strip FQDN from device_id ──
      // CDP often returns "switch01.example.com" — keep just the hostname
      let deviceId = nbr.device_id ?? nbr.neighbor ?? nbr.neighbor_name ?? '';
      if (deviceId.includes('.') && !deviceId.replace(/\./g, '').match(/^\d+$/)) {
        // Not an IP address — strip domain
        deviceId = deviceId.split('.')[0];
      }
      // Strip trailing serial number in parentheses: "SWITCH01(FDO1234ABCD)"
      deviceId = deviceId.replace(/\([^)]*\)\s*$/, '').trim();
      nbr.device_id = deviceId;

      // ── Normalize platform ──
      let platform = nbr.platform ?? '';
      if (!platform) {
        platform = nbr.neighbor_description ?? nbr.system_description ?? '';
        nbr.platform = platform;
      }
      if (platform) {
        const pl = platform.toLowerCase();
        // Extract meaningful platform from verbose CDP descriptions
        if (pl.includes('nx-os') || pl.includes('nexus')) {
          nbr.platform = 'Cisco NX-OS';
        } else if (pl.includes('ios-xe') || pl.includes('cat9') || pl.includes('c9')) {
          nbr.platform = 'Cisco IOS-XE';
        } else if (pl.includes('ios') || pl.includes('catalyst') || pl.includes('cisco')) {
          // Keep short model strings as-is: "WS-C3750X-48P"
          if (platform.length <= 30 && !pl.includes('software')) {
            // Already concise enough — leave it
          } else {
            nbr.platform = 'Cisco IOS';
          }
        } else if (pl.includes('arista')) {
          nbr.platform = 'Arista EOS';
        } else if (pl.includes('juniper')) {
          nbr.platform = 'Juniper JunOS';
        }
      }

      // ── Shorten interface names for graph edge labels ──
      for (const field of ['local_intf', 'remote_intf', 'local_interface', 'remote_interface'] as const) {
        let intf = nbr[field] ?? '';
        if (!intf) continue;

        for (const [longName, shortName] of Object.entries(INTF_SHORT)) {
          if (intf.startsWith(longName)) {
            intf = intf.replace(longName, shortName);
            break;
          }
        }
        nbr[field] = intf;
      }

      // Ensure canonical field names exist
      if (!nbr.local_intf && nbr.local_interface) {
        nbr.local_intf = nbr.local_interface;
      }
      if (!nbr.remote_intf && nbr.remote_interface) {
        nbr.remote_intf = nbr.remote_interface;
      }

      // ── Normalize capabilities ──
      // CDP capabilities come as "R S I" (space-separated letters) or
      // as a verbose string "Router, Switch, IGMP"
      let caps = nbr.capabilities ?? nbr.capability ?? '';
      if (Array.isArray(caps)) {
        caps = caps.join(', ');
      }
      if (caps) nbr.capabilities = String(caps).trim();

      // ── Management IP ──
      // CDP may put mgmt IP in mgmt_ip or management_ip
      if (!nbr.mgmt_ip && nbr.management_ip) {
        nbr.mgmt_ip = nbr.management_ip;
      }
    }

    return neighbors;
  }

  // ─── Interface Detail ────────────────────────────────────

  /**
   * Post-process interface detail rows for Cisco IOS/IOS-XE.
   *
   * Cisco `show interfaces` TextFSM output includes:
   *   bandwidth (e.g., "1000000 Kbit"), input_rate / output_rate (e.g., "1234 bits/sec"),
   *   in_errors, out_errors, crc, mtu, duplex, speed, etc.
   *
   * Pipeline:
   * 1. Parse bandwidth string → numeric bandwidth_kbps
   * 2. Convert rate strings to int bps
   * 3. Ensure error/packet counts are int
   * 4. Compute utilization_pct if bandwidth is known
   */
  static postProcessInterfaces(interfaces: Record<string, any>[]): Record<string, any>[] {
    for (const intf of interfaces) {
      // ── Parse bandwidth ──
      // Cisco format: "1000000 Kbit" or "1000000 Kb/sec" or "BW 1000000 Kbit/sec"
      const bwRaw = intf.bandwidth_raw ?? intf.bandwidth ?? intf.bw ?? '';
      let bwKbps = 0;
      if (bwRaw) {
        const bwStr = String(bwRaw);
        const m = bwStr.match(BW_PATTERN);
        if (m) {
          bwKbps = parseInt(m[1], 10);
        } else {
          // Try bare numeric (already in Kbps from TextFSM)
          const bare = parseInt(bwStr.replace(/[^0-9]/g, ''), 10);
          if (!isNaN(bare) && bare > 0) bwKbps = bare;
        }
      }
      intf.bandwidth_kbps = bwKbps;

      // ── Convert rate strings to int bps ──
      // Cisco TextFSM gives: input_rate "1234 bits/sec", output_rate "5678 bits/sec"
      // or input_rate_raw / output_rate_raw after normalize map
      for (const [rawField, bpsField] of [
        ['input_rate_raw', 'input_rate_bps'],
        ['output_rate_raw', 'output_rate_bps'],
      ]) {
        const rawVal = intf[rawField] ?? intf[bpsField] ?? intf[rawField.replace('_raw', '')];
        intf[bpsField] = parseRateToBps(rawVal);
      }

      // ── Ensure error counts are int ──
      for (const field of [
        'in_errors', 'out_errors', 'crc_errors', 'crc',
        'input_errors', 'output_errors',
        'runts', 'giants', 'throttles', 'collisions',
        'interface_resets', 'late_collisions',
      ]) {
        if (intf[field] != null) {
          intf[field] = toInt(intf[field], 0);
        }
      }

      // Alias Cisco-specific error field names to dashboard canonical names
      if (intf.in_errors == null && intf.input_errors != null) {
        intf.in_errors = intf.input_errors;
      }
      if (intf.out_errors == null && intf.output_errors != null) {
        intf.out_errors = intf.output_errors;
      }
      if (intf.crc_errors == null && intf.crc != null) {
        intf.crc_errors = intf.crc;
      }

      // ── Ensure packet counts are int ──
      for (const field of ['input_packets', 'output_packets']) {
        intf[field] = toInt(intf[field], 0);
      }

      // ── Ensure MTU is int ──
      intf.mtu = toInt(intf.mtu, 0);

      // ── Compute utilization percentage ──
      if (bwKbps > 0) {
        const bwBps = bwKbps * 1000;
        const peakBps = Math.max(intf.input_rate_bps ?? 0, intf.output_rate_bps ?? 0);
        intf.utilization_pct = Math.round((peakBps / bwBps) * 1000) / 10;
      } else {
        intf.utilization_pct = 0.0;
      }

      // ── Clean up intermediate fields ──
      delete intf.bandwidth_raw;
    }

    return interfaces;
  }
}

// ─── Register ────────────────────────────────────────────────

registerDriver('cisco_ios', CiscoIOSDriver);
registerDriver('cisco_ios_xe', CiscoIOSDriver);