/**
 * Wirlwind Telemetry — Workspace Overlay
 *
 * Convention-based workspace folder for user-customized templates
 * and collection definitions. Workspace files override built-in
 * ones file-for-file — no merging, no complexity.
 *
 * Config file: ~/.wirlwind/config.json
 *   { "workspace": "/home/user/wirlwind-workspace" }
 *
 * Workspace structure:
 *   ~/wirlwind-workspace/
 *   ├── templates/textfsm/       # Override individual TextFSM templates
 *   │   └── arista_eos_show_interfaces.textfsm
 *   └── collections/             # Override individual collection YAMLs
 *       └── cpu/
 *           └── arista_eos.yaml
 *
 * If ~/.wirlwind/config.json doesn't exist, or workspace path doesn't
 * exist, everything loads from built-in paths. No UI, no toggle —
 * power users create the directory, everyone else never knows it's there.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import log from 'electron-log';

const CONFIG_DIR = path.join(os.homedir(), '.wirlwind');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let workspacePath: string | null = null;

/**
 * Initialize workspace from ~/.wirlwind/config.json.
 * Call once at startup before initCollections/initParser.
 *
 * Also checks for ~/.wirlwind/workspace/ as a default
 * convention path if no config file exists.
 */
export function initWorkspace(): void {
  // ── Try config file first ──────────────────────────────
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      const ws = raw.workspace;
      if (ws && typeof ws === 'string') {
        // Expand ~ to home directory
        const resolved = ws.startsWith('~')
          ? path.join(os.homedir(), ws.slice(1))
          : ws;

        if (fs.existsSync(resolved)) {
          workspacePath = resolved;
          log.info(`Workspace: ${resolved}`);
          logWorkspaceContents(resolved);
          return;
        } else {
          log.warn(`Workspace path not found: ${resolved}`);
        }
      }
    } catch (err) {
      log.warn(`Failed to read ${CONFIG_FILE}: ${err}`);
    }
  }

  // ── Convention default: ~/.wirlwind/workspace/ ──────────
  const defaultWs = path.join(CONFIG_DIR, 'workspace');
  if (fs.existsSync(defaultWs)) {
    workspacePath = defaultWs;
    log.info(`Workspace (default): ${defaultWs}`);
    logWorkspaceContents(defaultWs);
    return;
  }

  // No workspace — everything loads from built-in paths
  workspacePath = null;
}

/**
 * Get the current workspace path, or null if no workspace is configured.
 */
export function getWorkspacePath(): string | null {
  return workspacePath;
}

/**
 * Check if a workspace is active.
 */
export function hasWorkspace(): boolean {
  return workspacePath !== null;
}

/**
 * Resolve a file path with workspace overlay.
 *
 * If workspace is active and the file exists under the workspace
 * at the given relative path, returns the workspace path.
 * Otherwise returns null (caller should fall back to built-in).
 *
 * @param relativePath - Path relative to workspace root (e.g., 'collections/cpu/arista_eos.yaml')
 * @returns Resolved workspace file path, or null
 */
export function resolveWorkspaceFile(relativePath: string): string | null {
  if (!workspacePath) return null;

  const wsFile = path.join(workspacePath, relativePath);
  if (fs.existsSync(wsFile)) {
    return wsFile;
  }
  return null;
}

/**
 * Log workspace contents at startup for visibility.
 */
function logWorkspaceContents(wsPath: string): void {
  const templateDir = path.join(wsPath, 'templates', 'textfsm');
  const collectionDir = path.join(wsPath, 'collections');

  let templateCount = 0;
  let collectionCount = 0;

  if (fs.existsSync(templateDir)) {
    try {
      templateCount = fs.readdirSync(templateDir)
        .filter(f => f.endsWith('.textfsm')).length;
    } catch { /* ignore */ }
  }

  if (fs.existsSync(collectionDir)) {
    try {
      const dirs = fs.readdirSync(collectionDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('_'));
      for (const dir of dirs) {
        const yamls = fs.readdirSync(path.join(collectionDir, dir.name))
          .filter(f => f.endsWith('.yaml') && !f.startsWith('_'));
        collectionCount += yamls.length;
      }
    } catch { /* ignore */ }
  }

  if (templateCount > 0 || collectionCount > 0) {
    log.info(`Workspace overrides: ${templateCount} templates, ${collectionCount} collections`);
  }
}