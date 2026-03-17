/**
 * Wirlwind Telemetry — Normalize Map Applicator
 *
 * Applies the `normalize` field-rename map from collection YAMLs.
 * This runs in pollEngine.runCycle() between lowercaseKeys and postProcess.
 *
 * The normalize map is { targetField: sourceField }:
 *   normalize:
 *     device_id: neighbor_name       → data.device_id = data.neighbor_name
 *     input_rate_raw: input_rate     → data.input_rate_raw = data.input_rate
 *
 * Applied to both flat dicts (cpu, memory) and arrays inside wrapper keys
 * (neighbors, interfaces). Source fields are preserved (copy, not move)
 * so drivers that check either name still work.
 */

import log from 'electron-log';

/**
 * Apply a normalize map to shaped data.
 *
 * @param data - Shaped output (may contain flat fields or wrapped arrays)
 * @param normalizeMap - { targetField: sourceField } from collection YAML
 * @param collectionName - For logging
 * @returns Data with renamed fields added
 */
export function applyNormalize(
  data: Record<string, any>,
  normalizeMap: Record<string, string>,
  collectionName?: string
): Record<string, any> {
  if (!normalizeMap || Object.keys(normalizeMap).length === 0) return data;

  // Find arrays of dicts to normalize (e.g., data.interfaces, data.neighbors)
  let arraysProcessed = false;
  for (const val of Object.values(data)) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      for (const item of val) {
        renameFields(item, normalizeMap);
      }
      arraysProcessed = true;
    }
  }

  // Also normalize top-level fields (for flat dicts like cpu, memory)
  if (!arraysProcessed) {
    renameFields(data, normalizeMap);
  }

  log.debug(`[${collectionName ?? '?'}] normalize applied: ${Object.keys(normalizeMap).join(', ')}`);
  return data;
}

/**
 * Copy source fields to target fields in a single dict.
 * Does NOT overwrite if target already has a truthy value.
 * Does NOT delete source fields — drivers may reference either name.
 */
function renameFields(
  obj: Record<string, any>,
  map: Record<string, string>
): void {
  for (const [target, source] of Object.entries(map)) {
    // Skip if source doesn't exist or target already has a value
    if (obj[source] != null && (obj[target] == null || obj[target] === '')) {
      obj[target] = obj[source];
    }
  }
}