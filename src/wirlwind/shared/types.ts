/**
 * Wirlwind Telemetry — Shared Type Definitions
 *
 * Used by both main process and renderer (via preload).
 * Mirrors Python dataclasses from the original wirlwind_telemetry.
 */

// ─── Device / Connection ─────────────────────────────────────

export interface DeviceTarget {
  host: string;
  port?: number;
  username: string;
  password?: string;
  keyFile?: string;
  keyContent?: string;
  keyPassphrase?: string;
  vendor: VendorType;
  legacyMode?: boolean;
  tags?: string[];
}

export type VendorType =
  | 'cisco_ios'
  | 'cisco_ios_xe'
  | 'cisco_nxos'
  | 'arista_eos'
  | 'juniper_junos';

export interface DeviceInfo {
  hostname?: string;
  ip: string;
  vendor: VendorType;
  username?: string;
  tags?: string[];
}

// ─── Collection Definitions (YAML) ──────────────────────────

export interface CollectionDef {
  command: string;
  parser: ParserType;
  textfsm_template?: string;
  regex_patterns?: RegexPattern[];
  ttp_template?: string;
  post_process?: string;
  interval?: number;           // Override default poll interval (seconds)
  timeout?: number;            // Command timeout override (ms)
  normalize?: Record<string, string>;
}

export type ParserType = 'textfsm' | 'regex' | 'ttp' | 'none';

export interface RegexPattern {
  name: string;
  pattern: string;
  group?: number;
  type?: 'int' | 'float' | 'string';
}

export interface CollectionSchema {
  name: string;
  description?: string;
  fields: SchemaField[];
}

export interface SchemaField {
  name: string;
  type: string;
  description?: string;
  optional?: boolean;
}

// ─── Parser Results ──────────────────────────────────────────

export interface ParsedResult {
  /** The parser that succeeded */
  _parsed_by: ParserType | 'none';

  /** TextFSM/regex template used (if any) */
  _template?: string;

  /** Error message if parse failed */
  _error?: string;

  /** Raw command output (for debug) */
  _raw?: string;

  /** Arbitrary parsed data */
  [key: string]: any;
}

// ─── State & History ─────────────────────────────────────────

export interface TelemetryState {
  collections: Record<string, ParsedResult>;
  device: DeviceInfo;
  history: {
    cpu: HistoryEntry[];
    memory: HistoryEntry[];
  };
}

export interface HistoryEntry {
  timestamp: number;     // Unix epoch seconds
  data: Record<string, any>;
}

// ─── Poll Engine ─────────────────────────────────────────────

export type PollStatus = 'idle' | 'polling' | 'paused' | 'error' | 'disconnected';

export interface PollConfig {
  intervalSeconds: number;      // Default: 30
  collections: string[];        // Which collections to poll (e.g., ['cpu', 'memory', 'interfaces'])
  historyMaxEntries: number;    // Ring buffer size (default: 720 = 6 hours @ 30s)
}

export const DEFAULT_POLL_CONFIG: PollConfig = {
  intervalSeconds: 30,
  collections: ['cpu', 'memory', 'interfaces', 'interface_detail', 'neighbors', 'log', 'device_info'],
  historyMaxEntries: 720,
};

// ─── IPC Channel Names ──────────────────────────────────────

export const IPC_CHANNELS = {
  // Renderer → Main
  CONNECT: 'wt:connect',
  DISCONNECT: 'wt:disconnect',
  START_POLLING: 'wt:start-polling',
  STOP_POLLING: 'wt:stop-polling',
  GET_SNAPSHOT: 'wt:get-snapshot',
  GET_HISTORY: 'wt:get-history',
  GET_STATUS: 'wt:get-status',

  // Main → Renderer
  STATE_CHANGED: 'wt:state-changed',
  CYCLE_COMPLETE: 'wt:cycle-complete',
  CONNECTION_STATUS: 'wt:connection-status',
  DEVICE_INFO: 'wt:device-info',
  POLL_STATUS: 'wt:poll-status',
  ERROR: 'wt:error',
} as const;

// ─── Driver Interface ────────────────────────────────────────

export interface VendorDriver {
  vendor: VendorType;

  /** Commands to run immediately after connect (enable mode, etc.) */
  postConnectCommands?: string[];

  /** Map of collection name → CollectionDef for this vendor */
  getCollections(): Record<string, CollectionDef>;

  /** Post-process raw parsed data into normalized form */
  postProcess(collection: string, raw: ParsedResult): ParsedResult;
}