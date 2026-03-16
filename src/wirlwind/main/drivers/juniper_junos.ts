/**
 * Wirlwind Telemetry — Juniper JunOS Vendor Driver
 * Ported from Python drivers/juniper_junos.py
 *
 * Handles JunOS-specific field normalization:
 *   - CPU: "show chassis routing-engine" → five_sec_total from idle %
 *   - Memory: same command → used_pct from memory_utilization field
 *   - Processes: "show system processes extensive" → top 15 by WCPU%
 *   - Neighbors: LLDP fields → dashboard neighbor graph format
 *   - Interface Detail: rate/error/bandwidth normalization
 *   - Log: BSD syslog format with keyword-based severity inference
 *
 * Key differences from Cisco/Arista:
 *   - CPU and memory come from the same command
 *   - Dual routing engines: driver picks master RE
 *   - LLDP neighbors need LAG deduplication
 *   - Interface output format differs significantly
 */

import log from 'electron-log';
import type { StateStore } from '../stateStore';
import {
  type VendorDriver,
  registerDriver,
  BaseDriver,
  normalizeBgpPeers,
  first,
  toFloat,
  toInt,
  parseRateToBps,
  BW_PATTERN,
} from './base';

// ─── JunOS syslog helpers ────────────────────────────────────

const JUNOS_MNEMONIC = /^([A-Z][A-Z0-9_]{2,}):\s*/;

const SEVERITY_KEYWORDS: [string, number][] = [
  ['panic', 0], ['kernel panic', 0],
  ['core dumped', 1], ['fatal', 1], ['abort', 1],
  ['down', 2],
  ['failed', 3], ['failure', 3], ['error', 3],
  ['warning', 4], ['warn', 4], ['exceeded', 4], ['threshold', 4],
  ['mismatch', 4], ['timeout', 4], ['closed', 4], ['exited', 4],
  ['accepted', 5], ['established', 5], ['logged in', 5],
];

// ─── JunOS process helpers ───────────────────────────────────

const RES_PATTERN = /^([\d.]+)\s*([KMGT])(?:B)?$/i;
const RES_MULTIPLIERS: Record<string, number> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

const KERNEL_FILTER = new Set(['idle', 'swapper', 'kernel', 'init']);
const KERNEL_PREFIX = ['swi', 'irq', 'g_', 'em0', 'em1', 'kqueue', 'thread', 'mastersh', 'yarrow', 'busdma'];

// ─── Neighbor field coalescing map ───────────────────────────

const NEIGHBOR_FIELD_MAP: Record<string, string[]> = {
  local_intf:           ['local_intf', 'local_interface'],
  remote_intf:          ['remote_intf', 'port_id', 'neighbor_interface'],
  device_id:            ['device_id', 'system_name', 'neighbor_name', 'chassis_id'],
  chassis_id:           ['chassis_id'],
  port_description:     ['port_description'],
  neighbor_description: ['neighbor_description', 'system_description'],
  mgmt_ip:              ['mgmt_ip', 'mgmt_address', 'management_ip'],
  capabilities:         ['capabilities'],
  parent_interface:     ['parent_interface'],
};

// ─── Interface abbreviations ─────────────────────────────────

const INTF_SHORT: Record<string, string> = {
  'ge-': 'ge-',
  'xe-': 'xe-',
  'et-': 'et-',
  'ae': 'ae',
  'lo': 'lo',
  'irb.': 'irb.',
  'Ethernet': 'Et',
  'GigabitEthernet': 'Gi',
  'TenGigabitEthernet': 'Te',
  'FastEthernet': 'Fa',
  'Management': 'Ma',
};

// ─── Driver ──────────────────────────────────────────────────

export class JuniperJunOSDriver extends BaseDriver {
  paginationCommand = 'set cli screen-length 0';
  postConnectCommands = ['set cli screen-length 0'];

  constructor(vendor: string) {
    super(vendor);
  }

  postProcess(
    collection: string,
    data: Record<string, any>,
    stateStore?: StateStore
  ): Record<string, any> {
    if (collection === 'cpu') {
      data = JuniperJunOSDriver.normalizeCpu(data);
      data = JuniperJunOSDriver.postProcessProcesses(data);
    } else if (collection === 'memory') {
      data = JuniperJunOSDriver.pickMasterRe(data);
      data = JuniperJunOSDriver.normalizeMemory(data);
    } else if (collection === 'log') {
      data = JuniperJunOSDriver.postProcessLogJunos(data);
    } else if (collection === 'bgp_summary' && data.peers) {
      data.peers = normalizeBgpPeers(data.peers);
    } else if (collection === 'neighbors' && data.neighbors) {
      data.neighbors = JuniperJunOSDriver.postProcessNeighbors(data.neighbors);
    } else if (collection === 'interface_detail' && data.interfaces) {
      data.interfaces = JuniperJunOSDriver.postProcessInterfaces(data.interfaces);
    }

    return data;
  }

  // ─── Dual-RE Handling ────────────────────────────────────

  /**
   * Handle dual routing engine output.
   * Picks master RE, clears bogus "processes" key from shaper.
   */
  static pickMasterRe(data: Record<string, any>): Record<string, any> {
    const backupRows = data.processes ?? [];
    delete data.processes;
    const status = String(data.status ?? '').toLowerCase();

    // If row[0] is backup and we have another row, check if it's master
    if (status === 'backup' && Array.isArray(backupRows)) {
      for (const row of backupRows) {
        if (String(row.status ?? '').toLowerCase() === 'master') {
          log.info(`Dual-RE: promoting master RE (slot ${row.slot ?? '?'}) over backup`);
          const masterData = { ...row, processes: [] };
          return masterData;
        }
      }
    }

    data.processes = [];
    return data;
  }

  // ─── CPU ─────────────────────────────────────────────────

  /**
   * Compute five_sec_total from idle percentage.
   * JunOS reports instantaneous CPU — no 5s/1m/5m averages.
   */
  static normalizeCpu(data: Record<string, any>): Record<string, any> {
    const idle = first(data.cpu_idle);
    const user = first(data.cpu_user);
    const kernel = first(data.cpu_kernel, data.cpu_sys);
    const interrupt = first(data.cpu_interrupt);
    const background = first(data.cpu_background);

    let total: number | null = null;
    if (idle != null) {
      total = Math.round((100.0 - idle) * 10) / 10;
    } else if (user != null) {
      total = Math.round(
        (user + (kernel ?? 0) + (interrupt ?? 0) + (background ?? 0)) * 10
      ) / 10;
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
   * Compute memory metrics from show chassis routing-engine fields.
   * JunOS provides memory_utilization as a direct percentage.
   */
  static normalizeMemory(data: Record<string, any>): Record<string, any> {
    const memPct = first(data.memory_utilization, data.used_pct);
    const dramMb = first(data.dram, data.mem_total);

    if (memPct != null) {
      data.used_pct = Math.round(memPct * 10) / 10;

      if (dramMb && dramMb > 0) {
        const totalMb = dramMb;
        const usedMb = Math.round((dramMb * memPct / 100.0) * 10) / 10;

        data.total_display = totalMb >= 1024
          ? `${(totalMb / 1024).toFixed(1)} GB`
          : `${Math.floor(totalMb)} MB`;
        data.used_display = usedMb >= 1024
          ? `${(usedMb / 1024).toFixed(1)} GB`
          : `${Math.floor(usedMb)} MB`;
        data.total = Math.floor(totalMb * 1024);  // KB for consistency
        data.used = Math.floor(usedMb * 1024);
        data.free = Math.floor((totalMb - usedMb) * 1024);
      }
    }

    return data;
  }

  // ─── Log ─────────────────────────────────────────────────

  /**
   * Post-process JunOS syslog entries.
   * Assembles timestamp, extracts mnemonic, infers severity from keywords.
   */
  static postProcessLogJunos(data: Record<string, any>): Record<string, any> {
    const entries = data.entries;
    if (!entries || !Array.isArray(entries) || entries.length === 0) return data;

    const processed: Record<string, any>[] = [];

    for (const entry of entries) {
      const month = entry.month ?? '';
      const day = entry.day ?? '';
      const timeStr = entry.time ?? '';
      const timestamp = `${month} ${day} ${timeStr}`.trim();

      const facility = entry.facility ?? '';
      const message = entry.message ?? '';

      // Extract mnemonic
      const m = JUNOS_MNEMONIC.exec(message);
      const mnemonic = m ? m[1] : (facility.replace(/^\//, '').toUpperCase() || 'SYSTEM');

      // Infer severity from keywords
      const text = `${facility} ${message}`.toLowerCase();
      let severity = 6;  // default: informational

      if (facility === '/kernel') severity = 4;

      for (const [keyword, sev] of SEVERITY_KEYWORDS) {
        if (text.includes(keyword) && sev < severity) {
          severity = sev;
        }
      }

      processed.push({
        timestamp,
        facility: facility.replace(/^\//, '') || 'system',
        severity,
        mnemonic,
        message,
      });
    }

    processed.reverse();
    data.entries = processed.slice(0, 50);
    return data;
  }

  // ─── Processes ───────────────────────────────────────────

  /**
   * Parse a memory size string to bytes.
   * Handles "45M", "12K" (with units) and bare integers (KB per BSD convention).
   */
  static parseResToBytes(resStr: any): number {
    if (resStr == null || resStr === '') return 0;
    const s = String(resStr).trim();
    if (!s || s === '0') return 0;

    const m = RES_PATTERN.exec(s);
    if (m) {
      const value = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      return Math.floor(value * (RES_MULTIPLIERS[unit] ?? 1));
    }

    // Bare integer — BSD ps RSS convention: value is in KB
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n * 1024;
  }

  /**
   * Post-process JunOS process data for the dashboard.
   * Reassembles full process list from shaper output, filters kernel threads.
   */
  static postProcessProcesses(data: Record<string, any>): Record<string, any> {
    const overflow = data.processes ?? [];
    const allRows = [...overflow];

    // Row[0] was flattened by shaper — rebuild it from top-level fields
    if (data.pid) {
      const row0: Record<string, any> = {};
      for (const key of [
        'pid', 'username', 'pri', 'nice', 'size',
        'res', 'rss', 'state', 'time', 'wcpu',
        'name', 'command', 'uid', 'ppid', 'cpu_sched',
        'stat', 'started', 'tt', 'wchan',
      ]) {
        if (data[key] != null) row0[key] = data[key];
      }
      allRows.unshift(row0);
    }

    if (allRows.length === 0) {
      data.processes = [];
      return data;
    }

    const normalized: Record<string, any>[] = [];

    for (const proc of allRows) {
      const name = proc.name ?? proc.command ?? '';
      const cleanName = name.replace(/^\[/, '').replace(/\]$/, '').trim();
      const nameLower = cleanName.toLowerCase();

      // Filter kernel threads and system idle
      if (KERNEL_FILTER.has(nameLower)) continue;
      if (KERNEL_PREFIX.some((pfx) => nameLower.startsWith(pfx))) continue;

      // Parse CPU percentage
      const wcpuRaw = proc.wcpu ?? proc.cpu_pct;
      let cpuPct = 0.0;
      if (wcpuRaw != null && wcpuRaw !== '') {
        const parsed = parseFloat(String(wcpuRaw).replace(/%$/, ''));
        if (!isNaN(parsed)) cpuPct = Math.round(parsed * 100) / 100;
      }

      // Parse memory
      const resRaw = proc.res ?? proc.rss;
      const holding = JuniperJunOSDriver.parseResToBytes(resRaw);

      let pid: string | number = proc.pid ?? '';
      const pidNum = parseInt(String(pid), 10);
      if (!isNaN(pidNum)) pid = pidNum;

      normalized.push({
        pid,
        name: cleanName,
        cpu_pct: cpuPct,
        holding,
      });
    }

    // Sort by CPU% descending, memory as tiebreaker
    normalized.sort((a, b) => {
      const cpuDiff = b.cpu_pct - a.cpu_pct;
      if (cpuDiff !== 0) return cpuDiff;
      return b.holding - a.holding;
    });

    data.processes = normalized.slice(0, 15);
    return data;
  }

  // ─── Neighbors ───────────────────────────────────────────

  /**
   * Normalize LLDP/CDP neighbor fields for the dashboard graph.
   * Coalesces raw TextFSM names, deduplicates LAG members,
   * disambiguates duplicate device_ids, infers platform and capabilities.
   */
  static postProcessNeighbors(neighbors: Record<string, any>[]): Record<string, any>[] {
    // Step 1: Coalesce fields
    for (const nbr of neighbors) {
      for (const [canonical, candidates] of Object.entries(NEIGHBOR_FIELD_MAP)) {
        if (nbr[canonical]) continue;
        for (const rawKey of candidates) {
          const val = nbr[rawKey];
          if (val && val !== '-') {
            nbr[canonical] = val;
            break;
          }
        }
      }
    }

    // Step 2: Strip FQDN from device_id
    for (const nbr of neighbors) {
      const deviceId = nbr.device_id ?? '';
      if (deviceId.includes('.') && !deviceId.replace(/\./g, '').match(/^\d+$/)) {
        nbr.device_id = deviceId.split('.')[0];
      }
    }

    // Step 3: Deduplicate LAG member links
    const seenLag: Record<string, boolean> = {};
    const deduped: Record<string, any>[] = [];
    for (const nbr of neighbors) {
      const deviceId = nbr.device_id ?? '';
      const parent = nbr.parent_interface ?? '';
      if (parent && parent !== '-' && deviceId) {
        const key = `${deviceId}|${parent}`;
        if (seenLag[key]) continue;
        seenLag[key] = true;
        nbr.local_intf = parent;  // Show ae0 instead of member link
      }
      deduped.push(nbr);
    }

    // Step 4: Disambiguate remaining duplicate device_ids
    const nameCount: Record<string, number> = {};
    for (const nbr of deduped) {
      const did = nbr.device_id ?? '';
      nameCount[did] = (nameCount[did] ?? 0) + 1;
    }
    if (Object.values(nameCount).some((v) => v > 1)) {
      const seenNames: Record<string, number> = {};
      for (const nbr of deduped) {
        const did = nbr.device_id ?? '';
        if ((nameCount[did] ?? 0) > 1) {
          seenNames[did] = (seenNames[did] ?? 0) + 1;
          if (seenNames[did] > 1) {
            nbr.device_id = `${did}:${nbr.local_intf ?? seenNames[did]}`;
          }
        }
      }
    }

    // Step 5: Platform inference and interface shortening
    for (const nbr of deduped) {
      let platform = nbr.platform ?? '';
      if (!platform) {
        const desc = nbr.neighbor_description ?? '';
        if (desc) {
          const dl = desc.toLowerCase();
          if (dl.includes('juniper') || dl.includes('junos')) platform = 'Juniper JunOS';
          else if (dl.includes('arista')) platform = 'Arista EOS';
          else if (dl.includes('cisco') && dl.includes('nx-os')) platform = 'Cisco NX-OS';
          else if (dl.includes('cisco')) platform = 'Cisco IOS';
          else platform = desc.substring(0, 40);
        }
        nbr.platform = platform;
      }

      // Shorten remote interface names
      for (const field of ['local_intf', 'remote_intf']) {
        const intf = nbr[field] ?? '';
        for (const [longName, shortName] of Object.entries(INTF_SHORT)) {
          if (intf.startsWith(longName) && longName !== shortName) {
            nbr[field] = intf.replace(longName, shortName);
            break;
          }
        }
      }

      // Capabilities inference for node shape
      let caps = nbr.capabilities ?? '';
      if (!caps && platform) {
        const pl = platform.toLowerCase();
        if (['router', 'mx', 'srx', 'ptx'].some((kw) => pl.includes(kw))) {
          caps = 'Router';
        } else if (['switch', 'ex', 'qfx'].some((kw) => pl.includes(kw))) {
          caps = 'Switch';
        }
      }
      if (caps) {
        if (Array.isArray(caps)) caps = caps.join(', ');
        nbr.capabilities = String(caps).trim();
      }
    }

    return deduped;
  }

  // ─── Interface Detail ────────────────────────────────────

  /**
   * Post-process interface detail rows for Juniper JunOS.
   * Ensures all dashboard-expected fields exist as correct types.
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

      // Ensure rate fields are int bps
      for (const field of ['input_rate_bps', 'output_rate_bps']) {
        let raw = intf[field];
        if (raw != null) {
          intf[field] = parseRateToBps(raw);
        } else {
          const altField = field.replace('_bps', '');
          const rawAlt = intf[altField];
          intf[field] = rawAlt != null ? parseRateToBps(rawAlt) : 0;
        }
      }

      // Ensure error counts are int
      for (const field of ['in_errors', 'out_errors', 'crc_errors']) {
        intf[field] = toInt(intf[field], 0);
      }

      // Ensure MTU is int
      const mtuRaw = intf.mtu ?? '';
      intf.mtu = String(mtuRaw).toLowerCase() === 'unlimited' ? 65535 : toInt(mtuRaw, 0);

      // Map link_status for consistency
      if (!intf.status) {
        const admin = String(intf.admin_state ?? '').toLowerCase();
        const link = String(intf.link_status ?? '').toLowerCase();
        intf.status = (admin === 'disabled' || admin === 'down') ? 'admin down' : link;
      }

      // Compute utilization percentage
      if (bwKbps > 0) {
        const bwBps = bwKbps * 1000;
        const peakBps = Math.max(intf.input_rate_bps, intf.output_rate_bps);
        intf.utilization_pct = Math.round((peakBps / bwBps) * 1000) / 10;
      } else {
        intf.utilization_pct = 0.0;
      }

      delete intf.bandwidth_raw;
    }

    return interfaces;
  }
}

// ─── Register ────────────────────────────────────────────────

registerDriver('juniper_junos', JuniperJunOSDriver);