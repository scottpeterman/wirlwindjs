/**
 * Wirlwind Telemetry — Vendor Driver Base
 * Ported from Python drivers/__init__.py
 *
 * Shared transforms used by all vendor drivers:
 *   - shape_output: parser rows → state store dict
 *   - computeMemoryPct: vendor-agnostic memory % calculation
 *   - postProcessLog: structured log assembly with raw-text fallback
 *   - normalizeBgpPeers: state/prefix normalization
 *   - filterCpuProcesses: idle process removal + field aliasing
 *   - mergeMemoryIntoProcesses: cross-collection join
 *
 * Registry pattern: registerDriver() / getDriver()
 */

import log from 'electron-log';
import type { ParsedResult } from '../../shared/types';
import type { StateStore } from '../stateStore';
import { parseGenericLog } from './logParsers';

// ─── Driver Interface ────────────────────────────────────────

export interface VendorDriver {
  vendor: string;

  /** Command to disable CLI pagination on this vendor */
  paginationCommand: string;

  /** Commands to run immediately after connect (enable mode, etc.) */
  postConnectCommands?: string[];

  /**
   * Convert parsed rows into the dict structure the state store expects.
   * Single-row collections (cpu, memory) → flat dict.
   * Multi-row collections (interfaces, bgp) → { listKey: [rows] }.
   */
  shapeOutput(collection: string, rows: Record<string, any>[]): Record<string, any>;

  /**
   * Apply vendor-specific transforms after parsing and shaping.
   * Called by the poll engine after shapeOutput.
   */
  postProcess(
    collection: string,
    data: Record<string, any>,
    stateStore?: StateStore
  ): Record<string, any>;
}

// ─── Driver Registry ─────────────────────────────────────────

const _driverRegistry: Record<string, new (vendor: string) => VendorDriver> = {};

export function registerDriver(vendorId: string, driverClass: new (vendor: string) => VendorDriver): void {
  _driverRegistry[vendorId] = driverClass;
  log.debug(`Registered driver: ${vendorId} → ${driverClass.name}`);
}

export function getDriver(vendor: string): VendorDriver | null {
  let DriverClass = _driverRegistry[vendor];

  // Fallback: try without trailing platform suffix (cisco_ios_xe → cisco_ios)
  if (!DriverClass && vendor.includes('_')) {
    const base = vendor.substring(0, vendor.lastIndexOf('_'));
    DriverClass = _driverRegistry[base];
  }

  if (!DriverClass) {
    log.info(`No driver registered for '${vendor}', using BaseDriver`);
    return new BaseDriver(vendor);
  }

  return new DriverClass(vendor);
}

export function listDrivers(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [vid, cls] of Object.entries(_driverRegistry)) {
    result[vid] = cls.name;
  }
  return result;
}

// ─── Constants ───────────────────────────────────────────────

/** Default wrapper keys for multi-row collections */
export const COLLECTION_LIST_KEYS: Record<string, string> = {
  interfaces: 'interfaces',
  interface_detail: 'interfaces',
  bgp_summary: 'peers',
  neighbors: 'neighbors',
  log: 'entries',
  environment: 'sensors',
};

/** Collections where rows collapse to a flat dict (first row = summary) */
export const SINGLE_ROW_COLLECTIONS = new Set(['cpu', 'memory', 'device_info']);

// ─── Base Driver ─────────────────────────────────────────────

export class BaseDriver implements VendorDriver {
  vendor: string;
  paginationCommand = '';  // Empty = use shotgun approach
  postConnectCommands?: string[];

  constructor(vendor: string) {
    this.vendor = vendor;
  }

  shapeOutput(collection: string, rows: Record<string, any>[]): Record<string, any> {
    return defaultShapeOutput(collection, rows);
  }

  postProcess(
    collection: string,
    data: Record<string, any>,
    stateStore?: StateStore
  ): Record<string, any> {
    if (collection === 'memory') {
      data = computeMemoryPct(data);
    }
    if (collection === 'log') {
      if (data._raw) {
        const parsed = parseGenericLog(data._raw);
        if (parsed.some((e: any) => e.mnemonic !== 'RAW')) {
          data.entries = parsed;
          data._log_source = 'driver';
        } else {
          // No structured lines found — pass raw lines through
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
    }
    if (collection === 'bgp_summary' && data.peers) {
      data.peers = normalizeBgpPeers(data.peers);
    }
    if (collection === 'device_info') {
      data = flattenDeviceInfo(data);
    }
    return data;
  }
}

// ─── Shared Transforms ───────────────────────────────────────

/**
 * Convert parser chain rows into state store dict.
 *
 * Single-row collections (cpu, memory) → flat dict.
 * Multi-row collections (interfaces, bgp) → { listKey: [rows] }.
 * CPU special case: first row is summary, rest are processes.
 */
export function defaultShapeOutput(
  collection: string,
  rows: Record<string, any>[]
): Record<string, any> {
  if (!rows || rows.length === 0) return {};

  if (SINGLE_ROW_COLLECTIONS.has(collection)) {
    const result = { ...rows[0] };
    // CPU: multiple rows = summary + process list
    if (collection === 'cpu' && rows.length > 1) {
      result.processes = rows.slice(1);
    }
    return result;
  }

  // Multi-row: wrap in expected key
  const key = COLLECTION_LIST_KEYS[collection];
  if (key) {
    return { [key]: rows };
  }

  // Unknown collection: generic wrapper
  return { data: rows };
}

/**
 * Compute used_pct from whatever memory fields are available.
 * Vendor-agnostic — tries canonical names, then raw TextFSM names.
 */
export function computeMemoryPct(data: Record<string, any>): Record<string, any> {
  let total = firstNumeric(data, 'total_bytes', 'total_kb', 'total_mb', 'total', 'memory_total');
  let used = firstNumeric(data, 'used_bytes', 'used_kb', 'used_mb', 'used', 'memory_used');
  const free = firstNumeric(data, 'free_bytes', 'free', 'free_kb', 'memory_free');

  // Derive used from total - free
  if (total != null && free != null && used == null) {
    used = total - free;
  }

  if (total != null && used != null && total > 0) {
    data.used_pct = Math.round((used / total) * 1000) / 10;

    // Human-readable display values
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

/**
 * Filter idle processes and add dashboard-friendly field aliases.
 */
export function filterCpuProcesses(data: Record<string, any>): Record<string, any> {
  const processes = data.processes;
  if (!processes || !Array.isArray(processes)) return data;

  const active: Record<string, any>[] = [];

  for (const proc of processes) {
    // Alias fields for dashboard
    proc.pid = proc.pid ?? proc.process_pid ?? '';
    proc.name = proc.name ?? proc.process_name ?? '';

    const cpu5s = toFloat(
      proc.five_sec ?? proc.cpu_pct ?? proc.process_cpu_usage_5_sec
    );

    if (cpu5s != null && cpu5s > 0) {
      proc.five_sec = cpu5s;
      proc.cpu_1min = toFloat(
        proc.cpu_1min ?? proc.process_cpu_usage_1_min ?? '0'
      ) ?? 0;
      proc.cpu_5min = toFloat(
        proc.cpu_5min ?? proc.process_cpu_usage_5_min ?? '0'
      ) ?? 0;
      active.push(proc);
    } else if (cpu5s == null) {
      // Can't parse — keep it, don't silently discard
      active.push(proc);
    }
  }

  data.processes = active;
  return data;
}

/**
 * Cross-reference per-process memory from the memory collection
 * into CPU process dicts.
 */
export function mergeMemoryIntoProcesses(
  data: Record<string, any>,
  stateStore?: StateStore
): Record<string, any> {
  const processes = data.processes;
  if (!processes || !stateStore) return data;

  const memData = stateStore.getCollection('memory');
  if (!memData) return data;

  const pids = memData.process_id;
  const holdings = memData.process_holding;
  if (!Array.isArray(pids) || !Array.isArray(holdings) || pids.length !== holdings.length) {
    return data;
  }

  const pidToHolding: Record<string, number> = {};
  for (let i = 0; i < pids.length; i++) {
    const h = parseInt(String(holdings[i]), 10);
    if (!isNaN(h)) {
      pidToHolding[String(pids[i])] = h;
    }
  }

  for (const proc of processes) {
    const pid = String(proc.pid ?? proc.process_pid ?? '');
    if (pid in pidToHolding) {
      proc.holding = pidToHolding[pid];
    }
  }

  return data;
}

/**
 * Normalize BGP peer state across vendors.
 * state_pfx is either a state string ("Idle") or a number (prefix count = established).
 */
export function normalizeBgpPeers(peers: Record<string, any>[]): Record<string, any>[] {
  for (const peer of peers) {
    const statePfx = String(peer.state_pfx ?? '');
    const pfxCount = parseInt(statePfx, 10);
    if (!isNaN(pfxCount)) {
      peer.state = 'Established';
      peer.prefixes_rcvd = pfxCount;
    } else {
      peer.state = statePfx || 'Unknown';
      peer.prefixes_rcvd = 0;
    }
  }
  return peers;
}

/**
 * Flatten List fields from TextFSM in device_info data.
 *
 * Cisco TextFSM templates use `Value List HARDWARE` and `Value List SERIAL`
 * which return arrays. The dashboard expects scalar strings. This also
 * trims whitespace and cleans up empty values.
 */
export function flattenDeviceInfo(data: Record<string, any>): Record<string, any> {
  // Flatten any array fields to first element
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key]) && !key.startsWith('_')) {
      data[key] = data[key][0] ?? '';
    }
  }

  // Trim string values
  for (const key of Object.keys(data)) {
    if (typeof data[key] === 'string') {
      data[key] = data[key].trim();
    }
  }

  return data;
}

/**
 * Post-process log entries with raw-text fallback.
 *
 * Happy path: assemble timestamps, join message lists, coerce severity.
 * Fallback: if _raw_output is present, split into one entry per line.
 */
export function postProcessLog(
  data: Record<string, any>,
  maxEntries = 50
): Record<string, any> {
  let entries = data.entries;
  const rawOutput: string = data._raw_output ?? '';

  // No entries → try raw fallback
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    if (rawOutput) {
      data.entries = rawTextToLogEntries(rawOutput, maxEntries);
      data._log_fallback = 'raw_text';
    }
    return data;
  }

  // Process structured entries
  const good: Record<string, any>[] = [];
  let failures = 0;

  for (const entry of entries) {
    try {
      // Assemble timestamp from components
      if (!entry.timestamp && entry.month) {
        const parts = [entry.month, entry.day, entry.time].filter(Boolean);
        let ts = parts.join(' ');
        if (entry.timezone) ts += ` ${entry.timezone}`;
        entry.timestamp = ts;
      }

      // Join message list
      if (Array.isArray(entry.message)) {
        entry.message = entry.message.filter(Boolean).join(' ');
      }

      // Coerce severity
      if (entry.severity != null) {
        const sev = parseInt(String(entry.severity), 10);
        if (!isNaN(sev)) entry.severity = sev;
      }

      good.push(entry);
    } catch (err) {
      failures++;
    }
  }

  if (failures > 0) {
    log.warn(`Log: ${failures}/${entries.length} entries failed structured processing`);
  }

  // All structured entries failed → raw fallback
  if (good.length === 0 && rawOutput) {
    data.entries = rawTextToLogEntries(rawOutput, maxEntries);
    data._log_fallback = 'raw_text';
    return data;
  }

  // Newest first
  good.reverse();
  data.entries = good.slice(0, maxEntries);
  return data;
}

/**
 * Fallback: split raw CLI output into one log entry per line.
 */
export function rawTextToLogEntries(
  rawText: string,
  maxEntries = 50
): Record<string, any>[] {
  if (!rawText) return [];

  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const entries = lines.map((line) => ({
    timestamp: '',
    facility: '',
    severity: 6,
    mnemonic: 'RAW',
    message: line,
  }));

  entries.reverse();
  return entries.slice(0, maxEntries);
}

// ─── Utility Helpers ─────────────────────────────────────────

/** Return the first non-null numeric value from a sequence of keys. */
export function firstNumeric(data: Record<string, any>, ...keys: string[]): number | null {
  for (const key of keys) {
    const val = data[key];
    if (val != null) {
      const n = parseFloat(String(val).replace(/,/g, ''));
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

/** Safely convert a value to float. */
export function toFloat(val: any): number | null {
  if (val == null) return null;
  const n = parseFloat(String(val).replace(/%/g, '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

/** Safely convert to int with fallback. */
export function toInt(val: any, fallback = 0): number {
  if (val == null || val === '') return fallback;
  const n = parseInt(String(val).trim(), 10);
  return isNaN(n) ? fallback : n;
}

/** Return first non-null toFloat result from values. */
export function first(...vals: any[]): number | null {
  for (const v of vals) {
    const r = toFloat(v);
    if (r != null) return r;
  }
  return null;
}

/**
 * Parse a rate string with units to integer bps.
 * Handles: "0 bps", "1234 bps", "1.23 Kbps", "5.67 Mbps", "1.2 Gbps", bare ints.
 */
export function parseRateToBps(rateStr: any): number {
  if (rateStr == null || rateStr === '') return 0;
  const s = String(rateStr).trim();

  // Try bare integer
  const intVal = parseInt(s, 10);
  if (String(intVal) === s) return intVal;

  // Try bare float
  const floatVal = parseFloat(s);
  if (String(floatVal) === s) return Math.floor(floatVal);

  // Try rate with units
  const m = s.match(/([\d.]+)\s*(bps|[Kk]bps|[Mm]bps|[Gg]bps)/i);
  if (m) {
    const value = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const multipliers: Record<string, number> = {
      bps: 1,
      kbps: 1_000,
      mbps: 1_000_000,
      gbps: 1_000_000_000,
    };
    return Math.floor(value * (multipliers[unit] ?? 1));
  }

  return 0;
}

/** Regex to extract numeric Kbps from bandwidth field */
export const BW_PATTERN = /(\d+)\s*[Kk]/;