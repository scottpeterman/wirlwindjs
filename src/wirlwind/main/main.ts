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
 * Parse --connect CLI arguments for headless/test auto-connect.
 *
 * Usage:
 *   electron . --connect <host> <user> <pass> <vendor> [--legacy] [--port 22]
 *
 * Examples:
 *   electron . --connect 172.17.1.128 cisco cisco123 arista_eos
 *   electron . --connect 10.0.0.1 admin admin123 cisco_ios --legacy
 *   electron . --connect 10.0.0.1 admin admin123 juniper_junos --port 830
 *
 * Supported vendors: cisco_ios, cisco_ios_xe, cisco_nxos, arista_eos, juniper_junos
 */
function parseCLIConnect(): DeviceTarget | null {
  const args = process.argv;
  const idx = args.indexOf('--connect');
  if (idx === -1) return null;

  // Need at least 4 positional args after --connect: host user pass vendor
  const positional = args.slice(idx + 1).filter(a => !a.startsWith('--'));
  if (positional.length < 4) {
    log.warn('--connect requires: <host> <user> <pass> <vendor>');
    log.warn('  Vendors: cisco_ios, cisco_ios_xe, cisco_nxos, arista_eos, juniper_junos');
    return null;
  }

  const [host, username, password, vendor] = positional;

  const validVendors = ['cisco_ios', 'cisco_ios_xe', 'cisco_nxos', 'arista_eos', 'juniper_junos'];
  if (!validVendors.includes(vendor)) {
    log.warn(`Unknown vendor '${vendor}'. Valid: ${validVendors.join(', ')}`);
    return null;
  }

  const legacyMode = args.includes('--legacy');

  let port = 22;
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    const p = parseInt(args[portIdx + 1], 10);
    if (!isNaN(p)) port = p;
  }

  log.info(`CLI connect: ${host}:${port} user=${username} vendor=${vendor} legacy=${legacyMode}`);

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