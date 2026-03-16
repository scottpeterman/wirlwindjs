/**
 * Wirlwind Telemetry — Vendor Drivers
 * Ported from Python drivers/__init__.py
 *
 * Barrel exports + auto-registration via side-effect imports.
 * Importing this module registers all vendor drivers.
 *
 * Adding a new vendor:
 *   1. Create drivers/my_vendor.ts
 *   2. Extend BaseDriver, override postProcess
 *   3. Call registerDriver('my_vendor', MyVendorDriver) at module level
 *   4. Import the module here
 */

// ─── Base exports (used by poll engine and driver subclasses) ─

export {
  type VendorDriver,
  registerDriver,
  getDriver,
  listDrivers,
  BaseDriver,
  defaultShapeOutput,
  computeMemoryPct,
  filterCpuProcesses,
  mergeMemoryIntoProcesses,
  postProcessLog,
  normalizeBgpPeers,
  parseRateToBps,
  COLLECTION_LIST_KEYS,
  SINGLE_ROW_COLLECTIONS,
} from './base';

// ─── Import vendor drivers (triggers registration) ───────────

import './cisco_ios';       // cisco_ios, cisco_ios_xe, cisco_nxos
import './arista_eos';      // arista_eos
import './juniper_junos';   // juniper_junos