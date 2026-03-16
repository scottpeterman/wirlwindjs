/**
 * Whirlwind SSH Client — Filters & Constants
 * Ported from Python SCNG SSH Client
 *
 * ANSI sequence removal and pagination disable commands.
 */

/**
 * Remove ANSI escape sequences and control characters.
 *
 * Comprehensive pattern matching for:
 * - CSI sequences: ESC[...X
 * - Character set switches: ESC(A, ESC)B, etc.
 * - Bell character: \x07
 * - Control characters: \x00-\x08, \x0B, \x0C, \x0E-\x1F
 */
export function filterAnsiSequences(text: string): string {
  if (!text) return text;

  // Same pattern set as Python client — proven across 357+ devices
  const ansiPattern =
    /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][AB012]|\x07|[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

  return text.replace(ansiPattern, '');
}

/**
 * Pagination disable commands — shotgun approach.
 *
 * Fire all of these; wrong ones just error harmlessly.
 * Each command targets a specific vendor's pagination mechanism.
 */
export const PAGINATION_DISABLE_SHOTGUN: string[] = [
  'terminal length 0',         // Cisco IOS/IOS-XE/NX-OS, Arista, Dell, Ubiquiti
  'terminal pager 0',          // Cisco ASA
  'set cli screen-length 0',   // Juniper Junos
  'screen-length 0 temporary', // Huawei VRP
  'disable clipaging',         // Extreme EXOS
  'terminal more disable',     // Extreme VOSS
  'no page',                   // HP ProCurve
  'set cli pager off',         // Palo Alto
];