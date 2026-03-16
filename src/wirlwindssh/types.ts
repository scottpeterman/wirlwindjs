/**
 * Whirlwind SSH Client — Type Definitions
 * Ported from Python SCNG SSH Client (scng/discovery/ssh/client.py)
 *
 * These mirror the Python dataclasses and type hints, adapted
 * for TypeScript/ssh2 idioms.
 */

import type { Algorithms as SSH2Algorithms } from 'ssh2';

// ─── Client Configuration ────────────────────────────────────

export interface SSHClientConfig {
  /** Target host IP or hostname */
  host: string;

  /** SSH username */
  username: string;

  /** SSH password (password auth or key passphrase fallback) */
  password?: string;

  /** PEM key as string (in-memory — no disk touch) */
  keyContent?: string;

  /** Path to private key file */
  keyFile?: string;

  /** Passphrase for encrypted private keys */
  keyPassphrase?: string;

  /** SSH port (default: 22) */
  port?: number;

  /** Connection timeout in ms (default: 30000) */
  timeout?: number;

  /** Shell read timeout in ms (default: 3000) */
  shellTimeout?: number;

  /** Delay between commands in ms (default: 1000) */
  interCommandTime?: number;

  /** Prompt wait timeout in ms (default: 30000) */
  expectPromptTimeout?: number;

  /** Number of prompt detection attempts (default: 3) */
  promptCount?: number;

  /** Enable legacy cipher/KEX support (default: false) */
  legacyMode?: boolean;

  /** Enable debug logging (default: false) */
  debug?: boolean;
}

// ─── Resolved Config (with defaults applied) ─────────────────

export interface ResolvedSSHClientConfig {
  host: string;
  username: string;
  password?: string;
  keyContent?: string;
  keyFile?: string;
  keyPassphrase?: string;
  port: number;
  timeout: number;
  shellTimeout: number;
  interCommandTime: number;
  expectPromptTimeout: number;
  promptCount: number;
  legacyMode: boolean;
  debug: boolean;
}

export const DEFAULT_CONFIG: Omit<ResolvedSSHClientConfig, 'host' | 'username'> = {
  port: 22,
  timeout: 30000,
  shellTimeout: 3000,
  interCommandTime: 1000,
  expectPromptTimeout: 30000,
  promptCount: 3,
  legacyMode: false,
  debug: false,
};

export function resolveConfig(config: SSHClientConfig): ResolvedSSHClientConfig {
  if (!config.host) throw new Error('host is required');
  if (!config.username) throw new Error('username is required');
  if (!config.password && !config.keyContent && !config.keyFile) {
    throw new Error('Either password, keyContent, or keyFile required');
  }

  return {
    ...DEFAULT_CONFIG,
    ...config,
    port: config.port ?? DEFAULT_CONFIG.port,
    timeout: config.timeout ?? DEFAULT_CONFIG.timeout,
    shellTimeout: config.shellTimeout ?? DEFAULT_CONFIG.shellTimeout,
    interCommandTime: config.interCommandTime ?? DEFAULT_CONFIG.interCommandTime,
    expectPromptTimeout: config.expectPromptTimeout ?? DEFAULT_CONFIG.expectPromptTimeout,
    promptCount: config.promptCount ?? DEFAULT_CONFIG.promptCount,
    legacyMode: config.legacyMode ?? DEFAULT_CONFIG.legacyMode,
    debug: config.debug ?? DEFAULT_CONFIG.debug,
  };
}

// ─── Emulation Types ─────────────────────────────────────────

export interface EmulationEntry {
  hostname: string;
  port: number;
  source?: string;
}

export interface EmulationConfig {
  lookupPath?: string;
  bindHost?: string;
  creds?: [string, string];
}

// ─── Command Result ──────────────────────────────────────────

export interface CommandResult {
  /** Raw output text (ANSI-filtered) */
  output: string;

  /** Command that was executed */
  command: string;

  /** Whether the prompt was detected after the command */
  promptDetected: boolean;

  /** Execution time in ms */
  elapsed: number;
}

// ─── Client Events ───────────────────────────────────────────

export interface WhirlwindEvents {
  connected: () => void;
  disconnected: () => void;
  error: (err: Error) => void;
  data: (data: string) => void;
  prompt: (prompt: string) => void;
  emulated: (device: string) => void;
}