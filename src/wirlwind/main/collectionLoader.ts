/**
 * Wirlwind Telemetry — Collection Loader
 *
 * Reads YAML collection definitions from the collections/ directory.
 * Each collection (cpu, memory, interfaces, etc.) has a subdirectory
 * containing per-vendor YAML files and a _schema.yaml.
 *
 * Structure:
 *   collections/
 *     cpu/
 *       _schema.yaml       → field definitions
 *       cisco_ios.yaml      → command + parser config for IOS
 *       arista_eos.yaml     → command + parser config for EOS
 *       ...
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import log from 'electron-log';
import type { CollectionDef, CollectionSchema, VendorType } from '../shared/types';
import { getWorkspacePath } from './workspace';

let collectionsBasePath: string;

/**
 * Initialize the collection loader with the base path.
 * In dev: ./collections
 * In packaged app: process.resourcesPath/collections
 */
export function initCollections(basePath?: string): void {
  if (basePath) {
    collectionsBasePath = basePath;
  } else {
    // Try packaged app path first, fall back to project root
    const resourcePath = path.join(process.resourcesPath || '', 'collections');
    // In dev, __dirname is dist/wirlwind/main/ — go up 3 levels to project root
    const devPath = path.join(__dirname, '..', '..', '..', 'collections');
    const cwdPath = path.join(process.cwd(), 'collections');

    if (fs.existsSync(resourcePath)) {
      collectionsBasePath = resourcePath;
    } else if (fs.existsSync(devPath)) {
      collectionsBasePath = devPath;
    } else {
      collectionsBasePath = cwdPath;
    }
  }

  log.info(`Collections path: ${collectionsBasePath}`);
}

/**
 * Load a collection definition for a specific vendor.
 *
 * @param collection - Collection name (e.g., 'cpu', 'interfaces')
 * @param vendor - Vendor type (e.g., 'cisco_ios', 'arista_eos')
 * @returns CollectionDef or null if not found
 */
export function loadCollection(
  collection: string,
  vendor: VendorType
): CollectionDef | null {
  const label = `${collection}/${vendor}`;

  // ── Workspace override — check first ─────────────────────
  const ws = getWorkspacePath();
  if (ws) {
    const wsPath = path.join(ws, 'collections', collection, `${vendor}.yaml`);
    if (fs.existsSync(wsPath)) {
      try {
        const raw = fs.readFileSync(wsPath, 'utf-8');
        const rawDef = yaml.load(raw) as any;
        const def = normalizeCollectionDef(rawDef, label);
        if (def) {
          log.info(`[workspace] ${label}.yaml`);
          return def;
        }
      } catch (err) {
        log.error(`[workspace] Failed to load ${wsPath}: ${err}`);
      }
    }
  }

  // ── Built-in ─────────────────────────────────────────────
  const filePath = path.join(collectionsBasePath, collection, `${vendor}.yaml`);

  if (!fs.existsSync(filePath)) {
    log.debug(`No collection def: ${collection}/${vendor}.yaml`);
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const rawDef = yaml.load(raw) as any;
    const def = normalizeCollectionDef(rawDef, `${collection}/${vendor}`);
    if (!def) {
      log.warn(`Invalid collection def: ${collection}/${vendor}.yaml (no command field)`);
      return null;
    }
    return def;
  } catch (err) {
    log.error(`Failed to load ${filePath}: ${err}`);
    return null;
  }
}

/**
 * Load the schema for a collection.
 */
export function loadSchema(collection: string): CollectionSchema | null {
  const filePath = path.join(collectionsBasePath, collection, '_schema.yaml');

  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return yaml.load(raw) as CollectionSchema;
  } catch (err) {
    log.error(`Failed to load schema ${filePath}: ${err}`);
    return null;
  }
}

/**
 * Load all collection definitions for a vendor.
 * Scans the collections directory for subdirectories, and loads
 * the vendor-specific YAML from each.
 *
 * @param vendor - Vendor type
 * @returns Map of collection name → CollectionDef
 */
export function loadAllCollections(
  vendor: VendorType
): Record<string, CollectionDef> {
  const result: Record<string, CollectionDef> = {};

  if (!fs.existsSync(collectionsBasePath)) {
    log.warn(`Collections directory not found: ${collectionsBasePath}`);
    return result;
  }

  const entries = fs.readdirSync(collectionsBasePath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

    const def = loadCollection(entry.name, vendor);
    if (def) {
      result[entry.name] = def;
      log.info(`Loaded collection: ${entry.name}/${vendor} → ${def.parser} (${def.command.substring(0, 40)})`);
    }
  }

  log.info(`Loaded ${Object.keys(result).length} collections for ${vendor}`);
  return result;
}

/**
 * List all available collection names.
 */
export function listCollections(): string[] {
  if (!fs.existsSync(collectionsBasePath)) return [];

  return fs.readdirSync(collectionsBasePath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/**
 * List vendors that have definitions for a given collection.
 */
export function listVendorsForCollection(collection: string): VendorType[] {
  const dir = path.join(collectionsBasePath, collection);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
    .map((f) => f.replace('.yaml', '') as VendorType);
}

// ─── Python YAML Format Compatibility ────────────────────────

/**
 * Python YAML parser entry (from the `parsers:` array).
 */
interface PythonParserEntry {
  type: string;
  templates?: string[];
  template?: string;
  pattern?: string;
  flags?: string;
  groups?: Record<string, number>;
}

/**
 * Convert a Python-format YAML collection def to the TypeScript CollectionDef interface.
 *
 * Python format:
 *   command: "show processes top once"
 *   interval: 30
 *   parsers:
 *     - type: textfsm
 *       templates:
 *         - arista_eos_show_processes_top_once.textfsm
 *     - type: regex
 *       pattern: '%?Cpu\(s\):\s*...'
 *       groups:
 *         user_pct: 1
 *         system_pct: 2
 *   normalize:
 *     cpu_usr: global_cpu_percent_user
 *
 * TypeScript CollectionDef:
 *   command: string
 *   parser: 'textfsm' | 'regex' | 'ttp' | 'none'
 *   textfsm_template?: string
 *   regex_patterns?: RegexPattern[]
 *   normalize?: Record<string, string>
 *
 * If the YAML already uses the TS flat format (has `parser` field), it passes through unchanged.
 */
function normalizeCollectionDef(raw: any, label: string): CollectionDef | null {
  if (!raw || !raw.command) return null;

  // ── Already in TS flat format ──────────────────────────
  if (raw.parser && typeof raw.parser === 'string') {
    return raw as CollectionDef;
  }

  // ── Python format: convert parsers array → flat fields ──
  const def: CollectionDef = {
    command: raw.command,
    parser: 'none',
    interval: raw.interval,
    timeout: raw.timeout,
  };

  // Store normalize map for post-parse field remapping
  if (raw.normalize) {
    def.normalize = raw.normalize;
  }

  const parsers: PythonParserEntry[] = raw.parsers ?? [];

  for (const p of parsers) {
    if (p.type === 'textfsm') {
      // First TextFSM template wins
      const tmpl = p.templates?.[0] ?? p.template;
      if (tmpl && !def.textfsm_template) {
        def.textfsm_template = tmpl;
        if (def.parser === 'none') def.parser = 'textfsm';
      }
    } else if (p.type === 'regex' && p.pattern && p.groups) {
      // Convert regex groups map to RegexPattern array
      if (!def.regex_patterns) def.regex_patterns = [];

      for (const [name, group] of Object.entries(p.groups)) {
        def.regex_patterns.push({
          name,
          pattern: p.pattern,
          group: group as number,
          type: 'float',  // Default to float for numeric extraction
        });
      }

      if (def.parser === 'none') def.parser = 'regex';
    } else if (p.type === 'ttp') {
      const tmpl = p.templates?.[0] ?? p.template;
      if (tmpl && !def.ttp_template) {
        def.ttp_template = tmpl;
        if (def.parser === 'none') def.parser = 'ttp';
      }
    }
  }

  // If we found a TextFSM template but also have regex patterns,
  // keep parser as 'textfsm' — parserChain falls back to regex automatically
  if (def.textfsm_template) {
    def.parser = 'textfsm';
  }

  log.debug(`Normalized ${label}: parser=${def.parser}, template=${def.textfsm_template ?? 'none'}, regex=${def.regex_patterns?.length ?? 0}`);

  return def;
}