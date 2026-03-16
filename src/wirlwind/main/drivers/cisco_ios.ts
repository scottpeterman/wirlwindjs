/**
 * Wirlwind Telemetry — Cisco IOS/IOS-XE/NX-OS Vendor Driver
 *
 * Handles Cisco-specific field normalization:
 *   - CPU: five_sec/one_min/five_min from 'show processes cpu'
 *   - Memory: used/free from 'show processes memory sorted'
 *   - Processes: per-process CPU + cross-referenced memory holdings
 *   - Neighbors: CDP/LLDP field normalization
 *   - Interface Detail: rate/error/bandwidth normalization
 */

import log from 'electron-log';
import type { StateStore } from '../stateStore';
import {
  type VendorDriver,
  registerDriver,
  BaseDriver,
  computeMemoryPct,
  postProcessLog,
  normalizeBgpPeers,
  filterCpuProcesses,
  mergeMemoryIntoProcesses,
  first,
  toFloat,
  toInt,
  parseRateToBps,
  BW_PATTERN,
} from './base';

// ─── Interface abbreviations for graph labels ────────────────

const INTF_SHORT: Record<string, string> = {
  GigabitEthernet: 'Gi',
  TenGigabitEthernet: 'Te',
  FastEthernet: 'Fa',
  TwentyFiveGigE: 'Twe',
  FortyGigabitEthernet: 'Fo',
  HundredGigE: 'Hu',
  Ethernet: 'Eth',
  Management: 'Mgmt',
  Loopback: 'Lo',
  'Port-channel': 'Po',
  Vlan: 'Vl',
};

// ─── Driver ──────────────────────────────────────────────────

export class CiscoIOSDriver extends BaseDriver {
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
      data = CiscoIOSDriver.normalizeCpu(data);
      data = filterCpuProcesses(data);
      data = mergeMemoryIntoProcesses(data, stateStore);
    } else if (collection === 'memory') {
      data = CiscoIOSDriver.normalizeMemory(data);
      data = computeMemoryPct(data);
    } else if (collection === 'log') {
      data = postProcessLog(data);
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
   * Normalize Cisco CPU fields.
   * 'show processes cpu' via TextFSM/regex gives five_sec_total, one_min, five_min directly.
   * Ensure they're numeric.
   */
  static normalizeCpu(data: Record<string, any>): Record<string, any> {
    const fiveSec = first(data.five_sec_total, data.five_sec);
    const oneMin = first(data.one_min);
    const fiveMin = first(data.five_min);

    if (fiveSec != null) data.five_sec_total = fiveSec;
    if (oneMin != null) data.one_min = oneMin;
    if (fiveMin != null) data.five_min = fiveMin;

    return data;
  }

  // ─── Memory ──────────────────────────────────────────────

  /**
   * Normalize Cisco memory fields.
   * Ensures used/free/total are numeric before computeMemoryPct runs.
   */
  static normalizeMemory(data: Record<string, any>): Record<string, any> {
    for (const key of ['used', 'free', 'total']) {
      const val = data[key];
      if (val != null) {
        const n = parseFloat(String(val).replace(/,/g, ''));
        if (!isNaN(n)) data[key] = n;
      }
    }
    return data;
  }

  // ─── Neighbors ───────────────────────────────────────────

  /**
   * Normalize CDP/LLDP neighbor fields for the dashboard graph.
   */
  static postProcessNeighbors(neighbors: Record<string, any>[]): Record<string, any>[] {
    for (const nbr of neighbors) {
      // Strip FQDN from device_id
      const deviceId = nbr.device_id ?? '';
      if (deviceId.includes('.') && !deviceId.replace(/\./g, '').match(/^\d+$/)) {
        nbr.device_id = deviceId.split('.')[0];
      }

      // Shorten interface names
      for (const field of ['local_intf', 'remote_intf']) {
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
      if (Array.isArray(caps)) caps = caps.join(', ');
      if (caps) nbr.capabilities = String(caps).trim();
    }

    return neighbors;
  }

  // ─── Interface Detail ────────────────────────────────────

  /**
   * Post-process interface detail rows for Cisco IOS/IOS-XE.
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

      delete intf.bandwidth_raw;
    }

    return interfaces;
  }
}

// ─── Register ────────────────────────────────────────────────

registerDriver('cisco_ios', CiscoIOSDriver);
registerDriver('cisco_ios_xe', CiscoIOSDriver);
registerDriver('cisco_nxos', CiscoIOSDriver);