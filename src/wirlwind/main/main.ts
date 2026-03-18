/**
 * Wirlwind Telemetry — Electron Main Process
 *
 * Entry point. Creates the BrowserWindow, loads the dashboard,
 * and initializes the TelemetryBridge which owns the poll engine,
 * parser chain, state store, and SSH lifecycle.
 */

import { app, BrowserWindow, session } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import { TelemetryBridge } from './bridge';
import { initWorkspace } from './workspace';
import { initCollections } from './collectionLoader';
import { initParser } from './parserChain';
import type { DeviceTarget, VendorType } from '../shared/types';

// Import drivers to trigger registration
import './drivers';

let mainWindow: BrowserWindow | null = null;
let bridge: TelemetryBridge | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Wirlwind Telemetry',
    backgroundColor: '#0a0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load the dashboard HTML
  // Dev: src/wirlwind/renderer/index.html (relative to project root)
  // Packaged: resources/renderer/index.html (via extraResources)
  const dashboardPath = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', 'index.html')
    : path.join(__dirname, '..', '..', '..', 'src', 'wirlwind', 'renderer', 'index.html');
  mainWindow.loadFile(dashboardPath);

  // Initialize subsystems
  initWorkspace();
  initCollections();
  initParser();

  // Create the bridge (wires IPC, state store, poll engine)
  bridge = new TelemetryBridge(mainWindow);

  // ── CLI auto-connect ─────────────────────────────────────
  // Usage: electron . --connect <host> <user> <pass> <vendor> [--legacy] [--port 22]
  const cliTarget = parseCLIConnect();
  if (cliTarget) {
    // Wait for renderer to be ready before connecting
    mainWindow.webContents.on('did-finish-load', async () => {
      log.info(`CLI auto-connect: ${cliTarget.host} (${cliTarget.vendor})`);
      const result = await bridge!.connectToDevice(cliTarget);
      if (result.success) {
        log.info(`CLI auto-connect succeeded`);
      } else {
        log.error(`CLI auto-connect failed: ${result.error}`);
      }
    });
  }

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', async () => {
    if (bridge) {
      await bridge.destroy();
      bridge = null;
    }
    mainWindow = null;
  });

  log.info('Wirlwind Telemetry window created');
}

// ─── CLI Argument Parsing ─────────────────────────────────────

/**
 * Parse connection target from CLI arguments or environment variables.
 * CLI args take precedence over env vars.
 *
 * CLI usage:
 *   electron . --connect <host> <user> <pass> <vendor> [--legacy] [--port 22]
 *
 * Environment variables (used when --connect is absent):
 *   WT_HOST     - Device hostname or IP (required)
 *   WT_USER     - SSH username (required)
 *   WT_PASS     - SSH password (required)
 *   WT_VENDOR   - Vendor type (required)
 *   WT_PORT     - SSH port (default: 22)
 *   WT_LEGACY   - Set to "1" or "true" for legacy cipher mode
 *
 * Examples:
 *   # CLI
 *   electron . --connect 172.17.1.128 cisco cisco123 arista_eos
 *   electron . --connect 10.0.0.1 admin admin123 cisco_ios --legacy
 *
 *   # Environment (e.g., launched from nterm-js)
 *   WT_HOST=172.17.1.128 WT_USER=cisco WT_PASS=cisco123 WT_VENDOR=arista_eos electron .
 *
 * Supported vendors: cisco_ios, cisco_ios_xe, cisco_nxos, arista_eos, juniper_junos
 */
function parseCLIConnect(): DeviceTarget | null {
  const args = process.argv;
  const env = process.env;
  const validVendors = ['cisco_ios', 'cisco_ios_xe', 'cisco_nxos', 'arista_eos', 'juniper_junos'];

  let host: string | undefined;
  let username: string | undefined;
  let password: string | undefined;
  let vendor: string | undefined;
  let port = 22;
  let legacyMode = false;

  // ── Try CLI args first ─────────────────────────────────
  const idx = args.indexOf('--connect');
  if (idx !== -1) {
    const positional = args.slice(idx + 1).filter(a => !a.startsWith('--'));
    if (positional.length < 4) {
      log.warn('--connect requires: <host> <user> <pass> <vendor>');
      log.warn('  Vendors: ' + validVendors.join(', '));
      return null;
    }

    [host, username, password, vendor] = positional;
    legacyMode = args.includes('--legacy');

    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      const p = parseInt(args[portIdx + 1], 10);
      if (!isNaN(p)) port = p;
    }

    log.info(`CLI connect: ${host}:${port} user=${username} vendor=${vendor} legacy=${legacyMode}`);
  }

  // ── Fall back to env vars ──────────────────────────────
  if (!host && env.WT_HOST) {
    host = env.WT_HOST;
    username = env.WT_USER;
    password = env.WT_PASS;
    vendor = env.WT_VENDOR;

    if (env.WT_PORT) {
      const p = parseInt(env.WT_PORT, 10);
      if (!isNaN(p)) port = p;
    }

    legacyMode = env.WT_LEGACY === '1' || env.WT_LEGACY === 'true';

    log.info(`ENV connect: ${host}:${port} user=${username} vendor=${vendor} legacy=${legacyMode}`);
  }

  // ── Validate ───────────────────────────────────────────
  if (!host) return null;

  if (!username || !password || !vendor) {
    log.warn('Connection requires host, username, password, and vendor');
    return null;
  }

  if (!validVendors.includes(vendor)) {
    log.warn(`Unknown vendor '${vendor}'. Valid: ${validVendors.join(', ')}`);
    return null;
  }

  return {
    host,
    port,
    username,
    password,
    vendor: vendor as VendorType,
    legacyMode,
  };
}

// ─── App Lifecycle ───────────────────────────────────────────

app.whenReady().then(() => {
  // CSP: allow echarts CDN and Google Fonts
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com; " +
          "img-src 'self' data:; " +
          "connect-src 'self';"
        ],
      },
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (bridge) {
    await bridge.destroy();
  }
});