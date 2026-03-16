/**
 * Whirlwind SSH Client — NetEmulate Integration
 * Ported from Python SCNG SSH Client
 *
 * Transparent redirect of SSH connections to mock devices.
 * Set EMULATION_ENABLED = true and provide ip_lookup.json path to
 * redirect all SSH connections to NetEmulate mock device servers.
 *
 * Usage:
 *   import { enableEmulation, disableEmulation } from './emulation';
 *   const count = await enableEmulation('/path/to/ip_lookup.json');
 *   // ... all SSH connections now route to mock devices ...
 *   disableEmulation();
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from './logger';
import type { EmulationEntry, EmulationConfig } from './types';

// ─── Module State ────────────────────────────────────────────

let emulationEnabled = false;
let emulationLookup: Record<string, EmulationEntry> = {};
let emulationHost = '127.0.0.1';
let emulationCreds: [string, string] = ['admin', 'admin'];

const DEFAULT_LOOKUP_FILENAME = 'ip_lookup.json';

// ─── Search Paths ────────────────────────────────────────────

function getSearchPaths(): string[] {
  return [
    path.resolve(DEFAULT_LOOKUP_FILENAME),
    path.resolve(__dirname, DEFAULT_LOOKUP_FILENAME),
    path.join(os.homedir(), 'PycharmProjects', 'netemulate', DEFAULT_LOOKUP_FILENAME),
    // Electron app paths
    path.join(os.homedir(), '.whirlwind', DEFAULT_LOOKUP_FILENAME),
    path.join(os.homedir(), '.nterm', DEFAULT_LOOKUP_FILENAME),
  ];
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Enable emulation mode — redirect SSH connections to mock devices.
 *
 * @param config - Emulation configuration
 * @returns Number of IPs loaded into lookup table
 * @throws If lookup file not found
 */
export async function enableEmulation(config: EmulationConfig = {}): Promise<number> {
  let lookupPath = config.lookupPath;

  // Search for lookup file if not specified
  if (!lookupPath) {
    const searchPaths = getSearchPaths();
    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        lookupPath = p;
        break;
      }
    }
    if (!lookupPath) {
      const searched = getSearchPaths().map((p) => `  - ${p}`).join('\n');
      throw new Error(`Emulation lookup not found. Searched:\n${searched}`);
    }
  }

  if (!fs.existsSync(lookupPath)) {
    throw new Error(`Emulation lookup not found: ${lookupPath}`);
  }

  const raw = fs.readFileSync(lookupPath, 'utf-8');
  emulationLookup = JSON.parse(raw);
  emulationHost = config.bindHost ?? '127.0.0.1';
  emulationCreds = config.creds ?? ['admin', 'admin'];
  emulationEnabled = true;

  getLogger().info(`[EMULATION] Enabled — ${Object.keys(emulationLookup).length} IPs loaded from ${lookupPath}`);
  return Object.keys(emulationLookup).length;
}

/**
 * Disable emulation mode — restore normal SSH connections.
 */
export function disableEmulation(): void {
  emulationEnabled = false;
  emulationLookup = {};
  getLogger().info('[EMULATION] Disabled — connections restored to normal');
}

/**
 * Auto-load emulation lookup if enabled but lookup is empty.
 * Called internally on first lookup attempt.
 */
function autoLoadEmulation(): void {
  if (!emulationEnabled || Object.keys(emulationLookup).length > 0) return;

  const searchPaths = getSearchPaths();
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      emulationLookup = JSON.parse(raw);
      getLogger().info(`[EMULATION] Auto-loaded ${Object.keys(emulationLookup).length} IPs from ${p}`);
      return;
    }
  }
  getLogger().warn(`[EMULATION] ENABLED but no lookup file found`);
}

/**
 * Look up a host/IP in the emulation table.
 *
 * @param host - Target host IP or hostname
 * @returns Emulation entry or null if not found/not enabled
 */
export function lookupEmulation(host: string): EmulationEntry | null {
  if (!emulationEnabled) return null;

  // Auto-load on first lookup if needed
  if (Object.keys(emulationLookup).length === 0) {
    autoLoadEmulation();
    if (Object.keys(emulationLookup).length === 0) return null;
  }

  const result = emulationLookup[host] ?? null;

  if (result) {
    getLogger().debug(`[EMULATION] HIT ${host} -> ${result.hostname}:${result.port}`);
  } else {
    getLogger().debug(`[EMULATION] MISS ${host} (not in lookup table)`);
  }

  return result;
}

// ─── Accessors ───────────────────────────────────────────────

export function isEmulationEnabled(): boolean {
  return emulationEnabled;
}

export function getEmulationHost(): string {
  return emulationHost;
}

export function getEmulationCreds(): [string, string] {
  return [...emulationCreds] as [string, string];
}

export function getEmulationLookupSize(): number {
  return Object.keys(emulationLookup).length;
}