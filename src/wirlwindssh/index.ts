/**
 * Whirlwind SSH — Network Device SSH Automation for TypeScript
 * @packageDocumentation
 */

// ─── Core Client ─────────────────────────────────────────────
export { WhirlwindSSHClient } from './client';

// ─── Types ───────────────────────────────────────────────────
export type {
  SSHClientConfig,
  ResolvedSSHClientConfig,
  CommandResult,
  WhirlwindEvents,
  EmulationEntry,
  EmulationConfig,
} from './types';
export { DEFAULT_CONFIG, resolveConfig } from './types';

// ─── Emulation ───────────────────────────────────────────────
export {
  enableEmulation,
  disableEmulation,
  lookupEmulation,
  isEmulationEnabled,
  getEmulationHost,
  getEmulationCreds,
  getEmulationLookupSize,
} from './emulation';

// ─── Filters & Constants ─────────────────────────────────────
export { filterAnsiSequences, PAGINATION_DISABLE_SHOTGUN } from './filters';

// ─── Legacy Algorithms ───────────────────────────────────────
export { LEGACY_ALGORITHMS, MODERN_ALGORITHMS, getAlgorithms } from './legacy';

// ─── Logger ──────────────────────────────────────────────────
export type { WhirlwindLogger } from './logger';
export { setLogger, getLogger, SILENT_LOGGER } from './logger';