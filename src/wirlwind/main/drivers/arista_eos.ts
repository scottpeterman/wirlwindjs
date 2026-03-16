/**
 * Wirlwind Telemetry — Arista EOS Vendor Driver
 * Ported from Python drivers/arista_eos.py
 *
 * Handles EOS-specific field normalization:
 *   - CPU: Linux 'top' output → five_sec_total from idle percentage
 *   - Memory: KiB values from 'top' output → used_pct
 *   - Processes: Linux 'top' per-process rows → dashboard format
 *   - Neighbors: LLDP fields → dashboard neighbor graph format
 *   - Interface Detail: bandwidth/rate/error normalization
 */

import log from 'electron-log';
import type { StateStore } from '../stateStore';
import {
  type VendorDriver,
  registerDriver,
  BaseDriver,
  postProcessLog,
  normalizeBgpPeers,
  first,
  toFloat,
  toInt,
  parseRateToBps,
  BW_PATTERN,
} from './base';

// ─── Interface name abbreviations for graph labels ───────────

const INTF_SHORT: Record<string, string> = {
  Ethernet: 'Et',
  Management: 'Ma',
  Loopback: 'Lo',
  'Port-Channel': 'Po',
  Vlan: 'Vl',
  GigabitEthernet: 'Gi',
  TenGigabitEthernet: 'Te',
  FastEthernet: 'Fa',
  TwentyFiveGigE: 'Twe',
  FortyGigabitEthernet: 'Fo',
  HundredGigE: 'Hu',
};

// ─── Driver ──────────────────────────────────────────────────

export class AristaEOSDriver extends BaseDriver {
  paginationCommand = 'terminal length 0';
  postConnectCommands = ['terminal length 0'];

  constructor(vendor: string) {
    super(vendor);
  }

  postProcess(
    collection: string,
    data: Record<string, any>,
    stateStore?: StateStore
  ): Record<string, any> {
    if (collection === 'cpu') {
      data = AristaEOSDriver.normalizeCpu(data);
      data = AristaEOSDriver.buildProcessList(data);
    } else if (collection === 'memory') {
      data = AristaEOSDriver.normalizeMemory(data);
    } else if (collection === 'log') {
      data = postProcessLog(data);
    } else if (collection === 'bgp_summary' && data.peers) {
      data.peers = normalizeBgpPeers(data.peers);
    } else if (collection === 'neighbors' && data.neighbors) {
      data.neighbors = AristaEOSDriver.postProcessNeighbors(data.neighbors);
    } else if (collection === 'interface_detail' && data.interfaces) {
      data.interfaces = AristaEOSDriver.postProcessInterfaces(data.interfaces);
    }

    return data;
  }

  // ─── CPU ─────────────────────────────────────────────────

  /**
   * Compute five_sec_total from idle percentage.
   * Handles all possible field name paths:
   *   TextFSM:    global_cpu_percent_idle, global_cpu_percent_user, global_cpu_percent_system
   *   Regex:      idle_pct, user_pct, system_pct
   *   Normalized: cpu_idle, cpu_usr, cpu_sys
   */
  static normalizeCpu(data: Record<string, any>): Record<string, any> {
    const idle = first(
      data.global_cpu_percent_idle,
      data.idle_pct,
      data.cpu_idle
    );
    const user = first(
      data.global_cpu_percent_user,
      data.user_pct,
      data.cpu_usr
    );
    const system = first(
      data.global_cpu_percent_system,
      data.system_pct,
      data.cpu_sys
    );

    let total: number | null = null;
    if (idle != null) {
      total = Math.round((100.0 - idle) * 10) / 10;
    } else if (user != null) {
      total = Math.round((user + (system ?? 0)) * 10) / 10;
    }

    if (total != null) {
      data.five_sec_total = total;
      if (data.one_min == null) data.one_min = total;
      if (data.five_min == null) data.five_min = total;
    }

    return data;
  }

  // ─── Memory ──────────────────────────────────────────────

  /**
   * Compute used_pct from memory values.
   * Handles TextFSM (global_mem_total/free/used), regex (total_kb/free_kb/used_kb),
   * and normalized (mem_total/mem_free/mem_used) field names.
   */
  static normalizeMemory(data: Record<string, any>): Record<string, any> {
    const total = first(data.global_mem_total, data.mem_total, data.total_kb);
    let used = first(data.global_mem_used, data.mem_used, data.used_kb);
    const free = first(data.global_mem_free, data.mem_free, data.free_kb);

    if (used == null && total != null && free != null) {
      used = total - free;
    }

    if (total && total > 0 && used != null) {
      data.used_pct = Math.round((used / total) * 1000) / 10;
      data.used = Math.floor(used);
      data.total = Math.floor(total);
      data.free = free != null ? Math.floor(free) : Math.floor(total - used);
    }

    return data;
  }

  // ─── Processes ───────────────────────────────────────────

  /**
   * Alias Arista process fields to dashboard-expected names.
   *
   * TextFSM per-process rows from 'show processes top once' have:
   *   pid, command, percent_cpu, percent_memory, resident_memory_size
   *
   * Dashboard expects:
   *   pid, name, cpu_pct, five_sec, holding
   *
   * Unlike Cisco, Arista's 'top -n 1' snapshot often shows 0.0% for processes
   * not actively running. We keep top 20 sorted by CPU desc then memory desc.
   */
  static buildProcessList(data: Record<string, any>): Record<string, any> {
    const processes = data.processes;
    if (!processes || !Array.isArray(processes)) return data;

    const active: Record<string, any>[] = [];

    for (const proc of processes) {
      let cpuPct = first(proc.percent_cpu, proc.cpu_pct, proc.cpu);
      if (cpuPct == null) cpuPct = 0.0;

      proc.pid = proc.pid ?? '';
      proc.name = proc.command ?? proc.name ?? '';
      proc.cpu_pct = cpuPct;
      proc.five_sec = cpuPct;

      // Memory percent from top output
      const memPct = first(proc.percent_memory, proc.mem_pct);
      if (memPct != null) proc.mem_pct = memPct;

      // Memory: RES field from top (KB or with g/m suffix)
      const resStr = String(proc.resident_memory_size ?? proc.res ?? '0');
      let resKb = 0;
      if (resStr.endsWith('g')) {
        resKb = (toFloat(resStr.slice(0, -1)) ?? 0) * 1024 * 1024;
      } else if (resStr.endsWith('m')) {
        resKb = (toFloat(resStr.slice(0, -1)) ?? 0) * 1024;
      } else {
        resKb = toFloat(resStr) ?? 0;
      }

      if (resKb > 0) {
        if (resKb > 1_000_000) {
          proc.holding_display = `${Math.round(resKb / 1024)}M`;
        } else if (resKb > 1000) {
          proc.holding_display = `${Math.round(resKb)}K`;
        } else {
          proc.holding_display = `${Math.round(resKb)}`;
        }
        proc.holding = Math.floor(resKb * 1024);
      }

      active.push(proc);
    }

    // Sort by CPU descending, then by memory descending
    active.sort((a, b) => {
      const cpuDiff = (b.cpu_pct ?? 0) - (a.cpu_pct ?? 0);
      if (cpuDiff !== 0) return cpuDiff;
      return (b.mem_pct ?? 0) - (a.mem_pct ?? 0);
    });

    data.processes = active.slice(0, 20);
    return data;
  }

  // ─── Neighbors ───────────────────────────────────────────

  /**
   * Normalize LLDP neighbor fields for the dashboard graph.
   * Strips FQDN, extracts short platform, shortens interface names.
   */
  static postProcessNeighbors(neighbors: Record<string, any>[]): Record<string, any>[] {
    for (const nbr of neighbors) {
      // Strip FQDN from device_id
      const deviceId = nbr.device_id ?? '';
      if (deviceId.includes('.') && !deviceId.replace(/\./g, '').match(/^\d+$/)) {
        nbr.device_id = deviceId.split('.')[0];
      }

      // Extract short platform from verbose system description
      let platform = nbr.platform ?? '';
      if (!platform) {
        platform = nbr.neighbor_description ?? '';
        nbr.platform = platform;
      }

      if (platform) {
        const pl = platform.toLowerCase();
        if (pl.includes('arista')) nbr.platform = 'Arista EOS';
        else if (pl.includes('cisco') && pl.includes('nx-os')) nbr.platform = 'Cisco NX-OS';
        else if (pl.includes('cisco') && pl.includes('ios-xe')) nbr.platform = 'Cisco IOS-XE';
        else if (pl.includes('cisco')) nbr.platform = 'Cisco IOS';
        else if (pl.includes('juniper')) nbr.platform = 'Juniper JunOS';
      }

      // Shorten interface names for graph edge labels
      for (const field of ['local_intf', 'remote_intf'] as const) {
        const intf = nbr[field] ?? '';
        for (const [longName, shortName] of Object.entries(INTF_SHORT)) {
          if (intf.startsWith(longName)) {
            nbr[field] = intf.replace(longName, shortName);
            break;
          }
        }
      }

      // Normalize capabilities
      let caps = nbr.capabilities ?? '';
      if (Array.isArray(caps)) {
        caps = caps.join(', ');
      }
      if (caps) nbr.capabilities = String(caps).trim();
    }

    return neighbors;
  }

  // ─── Interface Detail ────────────────────────────────────

  /**
   * Post-process interface detail rows for Arista EOS.
   * 1. Parse bandwidth string → numeric bandwidth_kbps
   * 2. Convert rate strings to int bps
   * 3. Ensure error counts are int
   * 4. Compute utilization_pct if bandwidth is known
   */
  static postProcessInterfaces(interfaces: Record<string, any>[]): Record<string, any>[] {
    for (const intf of interfaces) {
      // Parse bandwidth
      const bwRaw = intf.bandwidth_raw ?? intf.bandwidth ?? '';
      let bwKbps = 0;
      if (bwRaw) {
        const m = String(bwRaw).match(BW_PATTERN);
        if (m) bwKbps = parseInt(m[1], 10);
      }
      intf.bandwidth_kbps = bwKbps;

      // Convert rate strings to int bps
      for (const [rawField, bpsField] of [
        ['input_rate_raw', 'input_rate_bps'],
        ['output_rate_raw', 'output_rate_bps'],
      ]) {
        const rawVal = intf[rawField] ?? intf[bpsField];
        intf[bpsField] = parseRateToBps(rawVal);
      }

      // Ensure error counts are int
      for (const field of ['in_errors', 'out_errors', 'crc_errors']) {
        intf[field] = toInt(intf[field], 0);
      }

      // Ensure MTU is int
      intf.mtu = toInt(intf.mtu, 0);

      // Compute utilization percentage
      if (bwKbps > 0) {
        const bwBps = bwKbps * 1000;
        const peakBps = Math.max(intf.input_rate_bps, intf.output_rate_bps);
        intf.utilization_pct = Math.round((peakBps / bwBps) * 1000) / 10;
      } else {
        intf.utilization_pct = 0.0;
      }

      // Clean up intermediate fields
      delete intf.bandwidth_raw;
    }

    return interfaces;
  }
}

// ─── Register ────────────────────────────────────────────────

registerDriver('arista_eos', AristaEOSDriver);