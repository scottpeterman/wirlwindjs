/**
 * Wirlwind Telemetry — Vendor Log Parsers
 *
 * Each vendor formats syslog output differently. These parsers extract
 * structured entries from raw `show logging` output, producing the
 * common format the dashboard expects:
 *
 *   { timestamp, facility, severity, mnemonic, message }
 *
 * Severity levels (RFC 5424):
 *   0 Emergency   1 Alert   2 Critical   3 Error
 *   4 Warning     5 Notice  6 Info       7 Debug
 *
 * Called from each vendor driver's postProcess('log', ...) method.
 * Dashboard updateLog() renders entries with color by severity.
 */

import log from 'electron-log';

export interface LogEntry {
  timestamp: string;
  facility: string;
  severity: number;
  mnemonic: string;
  message: string;
}

// ─── Arista EOS ──────────────────────────────────────────────

/**
 * Parse Arista EOS syslog output.
 *
 * Format:
 *   Mar 17 02:53:07 agg1 ConfigAgent: %SYS-5-CONFIG_I: Configured from console by cisco
 *   Mar 17 03:12:51 agg1 Ebra: %LINEPROTO-5-UPDOWN: Line protocol on Interface Ethernet3...
 *
 * The %FACILITY-SEVERITY-MNEMONIC pattern is standard Cisco/Arista syslog.
 */
const ARISTA_SYSLOG_RE = /^(\w+\s+\d+\s+[\d:]+)\s+\S+\s+\S+:\s+%(\w+)-(\d+)-(\w+):\s*(.*)$/;

export function parseAristaLog(raw: string, maxEntries = 50): LogEntry[] {
  if (!raw) return [];

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const entries: LogEntry[] = [];

  for (const line of lines) {
    const m = line.match(ARISTA_SYSLOG_RE);
    if (m) {
      entries.push({
        timestamp: m[1],
        facility: m[2],
        severity: parseInt(m[3], 10),
        mnemonic: m[4],
        message: m[5],
      });
    }
    // Skip non-syslog lines (command echo, banners, blank lines)
  }

  // Newest first
  entries.reverse();
  return entries.slice(0, maxEntries);
}

// ─── Cisco IOS / IOS-XE / NX-OS ─────────────────────────────

/**
 * Parse Cisco IOS/IOS-XE syslog output.
 *
 * Format variants:
 *   *Mar 17 02:53:07.123: %SYS-5-CONFIG_I: Configured from console
 *   Mar 17 02:53:07: %LINEPROTO-5-UPDOWN: Line protocol on Interface...
 *   000123: Mar 17 02:53:07: %SYS-5-CONFIG_I: Configured from console
 *
 * IOS prepends optional sequence number and may have leading '*' on timestamp.
 */
const CISCO_SYSLOG_RE = /^(?:\d+:\s*)?(\*?\w+\s+\d+\s+[\d:.]+)(?:\s+\S+)?:\s+%(\w+)-(\d+)-(\w+):\s*(.*)$/;

export function parseCiscoLog(raw: string, maxEntries = 50): LogEntry[] {
  if (!raw) return [];

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const entries: LogEntry[] = [];

  for (const line of lines) {
    const m = line.match(CISCO_SYSLOG_RE);
    if (m) {
      entries.push({
        timestamp: m[1].replace(/^\*/, ''),
        facility: m[2],
        severity: parseInt(m[3], 10),
        mnemonic: m[4],
        message: m[5],
      });
    }
  }

  entries.reverse();
  return entries.slice(0, maxEntries);
}

// ─── Juniper JunOS ───────────────────────────────────────────

/**
 * Parse Juniper JunOS syslog output (show log messages).
 *
 * Format:
 *   Jan 23 21:35:09   eventd[1983]: SYSTEM_ABNORMAL_SHUTDOWN: System abnormally shut down
 *   Jan 23 21:35:09   /kernel: FreeBSD is a registered trademark
 *   Jan 23 21:35:09   mgd[1234]: UI_COMMIT_COMPLETED: commit complete
 *
 * Juniper does NOT use %FAC-SEV-MNEM. Severity is inferred from known
 * mnemonic prefixes and keywords. Process name serves as facility.
 */
const JUNIPER_LOG_RE = /^(\w+\s+\d+\s+[\d:]+)\s+(\S+?)(?:\[\d+\])?:\s*(.*)$/;

/** Known Juniper mnemonics → severity mapping */
const JUNIPER_SEVERITY_MAP: Record<string, number> = {
  // Severity 2 — Critical
  SYSTEM_ABNORMAL_SHUTDOWN: 2,
  KERNEL_PANIC: 2,
  CHASSISD_CRASH: 2,

  // Severity 3 — Error
  OSPF_ADJACENCY_TEARDOWN: 3,
  OSPF3_ADJACENCY_TEARDOWN: 3,
  BGP_PEER_DOWN: 3,
  RPD_BGP_NEIGHBOR_STATE_CHANGED: 3,
  CHASSISD_FAN_FAILED: 3,
  CHASSISD_POWER_SUPPLY_FAILED: 3,
  KERN_ARP_ADDR_CHANGE: 3,

  // Severity 4 — Warning
  SNMPD_AUTH_FAILURE: 4,
  UI_AUTH_INVALID_CHALLENGE: 4,
  LOGIN_FAILED: 4,
  CHASSISD_FAN_DEGRADED: 4,
  UI_CMDLINE_READ_LINE: 4,
  RPD_BGP_NEIGHBOR_HOLD_TIMEOUT: 4,

  // Severity 5 — Notice
  UI_COMMIT_COMPLETED: 5,
  UI_COMMIT: 5,
  SYSTEM_OPERATIONAL: 5,
  OSPF_NEIGHBOR_UP: 5,
  BGP_PEER_UP: 5,
  UI_LOGIN_EVENT: 5,
  UI_LOGOUT_EVENT: 5,
  IFINFO_STATE_CHANGE: 5,

  // Severity 6 — Info
  UI_CMDLINE_READ_LINE_INFO: 6,
  SYSTEM_READY: 6,
};

/** Keyword-based severity fallback for unrecognized mnemonics */
function inferJuniperSeverity(process: string, message: string): number {
  const combined = (process + ' ' + message).toLowerCase();

  if (combined.includes('error') || combined.includes('fail') || combined.includes('crash')) return 3;
  if (combined.includes('warn') || combined.includes('invalid') || combined.includes('denied')) return 4;
  if (combined.includes('down') || combined.includes('teardown') || combined.includes('lost')) return 4;
  if (combined.includes('up') || combined.includes('established') || combined.includes('commit')) return 5;

  // /kernel lines are generally informational noise
  if (process === '/kernel') return 7;

  return 6;
}

export function parseJuniperLog(raw: string, maxEntries = 50): LogEntry[] {
  if (!raw) return [];

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const entries: LogEntry[] = [];

  for (const line of lines) {
    const m = line.match(JUNIPER_LOG_RE);
    if (!m) continue;

    const timestamp = m[1];
    const process = m[2];      // eventd, /kernel, mgd, rpd, etc.
    const body = m[3];

    // Try to extract MNEMONIC from the body (first colon-delimited token if UPPER_CASE)
    let mnemonic = '';
    let message = body;
    const colonIdx = body.indexOf(':');
    if (colonIdx > 0) {
      const candidate = body.substring(0, colonIdx).trim();
      if (/^[A-Z][A-Z0-9_]+$/.test(candidate)) {
        mnemonic = candidate;
        message = body.substring(colonIdx + 1).trim();
      }
    }

    // Determine severity
    let severity: number;
    if (mnemonic && JUNIPER_SEVERITY_MAP[mnemonic] != null) {
      severity = JUNIPER_SEVERITY_MAP[mnemonic];
    } else {
      severity = inferJuniperSeverity(process, body);
    }

    // Use process name as facility (strip leading / and trailing PID)
    const facility = process.replace(/^\//, '').replace(/\[\d+\]$/, '').toUpperCase();

    entries.push({
      timestamp,
      facility: facility || 'SYSTEM',
      severity,
      mnemonic: mnemonic || 'LOG',
      message,
    });
  }

  entries.reverse();
  return entries.slice(0, maxEntries);
}

// ─── Generic Fallback ────────────────────────────────────────

/**
 * Generic log parser — tries %FAC-SEV-MNEM first, then raw lines.
 * Used by BaseDriver for unknown vendors.
 */
const GENERIC_SYSLOG_RE = /%(\w+)-(\d+)-(\w+):\s*(.*)/;

export function parseGenericLog(raw: string, maxEntries = 50): LogEntry[] {
  if (!raw) return [];

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const entries: LogEntry[] = [];

  for (const line of lines) {
    const m = line.match(GENERIC_SYSLOG_RE);
    if (m) {
      entries.push({
        timestamp: '',
        facility: m[1],
        severity: parseInt(m[2], 10),
        mnemonic: m[3],
        message: m[4],
      });
    } else {
      // Raw line — no severity info, show as-is
      entries.push({
        timestamp: '',
        facility: '',
        severity: 6,
        mnemonic: 'RAW',
        message: line,
      });
    }
  }

  entries.reverse();
  return entries.slice(0, maxEntries);
}