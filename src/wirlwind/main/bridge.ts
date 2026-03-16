/**
 * Wirlwind Telemetry — IPC Bridge
 * Replaces Python bridge.py (QWebChannel ↔ QObject signals)
 *
 * This is the ONE module that changed from PyQt → Electron.
 * Python: QObject with @pyqtSlot/@pyqtSignal over QWebChannel
 * Electron: ipcMain.handle/on → BrowserWindow.webContents.send
 *
 * Everything else (poll engine, parser chain, state store)
 * is identical in architecture.
 */

import { BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log';
import { StateStore } from './stateStore';
import { PollEngine } from './pollEngine';
import { IPC_CHANNELS, DeviceTarget } from '../shared/types';

export class TelemetryBridge {
  private window: BrowserWindow;
  private state: StateStore;
  private engine: PollEngine;

  constructor(window: BrowserWindow) {
    this.window = window;
    this.state = new StateStore();
    this.engine = new PollEngine(this.state);

    this.wireStateEvents();
    this.wireEngineEvents();
    this.wireIpcHandlers();

    log.info('TelemetryBridge initialized');
  }

  // ─── State → Renderer ────────────────────────────────────

  private wireStateEvents(): void {
    // Collection data changed → push to renderer
    this.state.on('stateChanged', (collection: string, data: any) => {
      this.send(IPC_CHANNELS.STATE_CHANGED, { collection, data });
    });

    // Device info changed
    this.state.on('deviceInfoChanged', (info: any) => {
      this.send(IPC_CHANNELS.DEVICE_INFO, info);
    });
  }

  // ─── Engine → Renderer ───────────────────────────────────

  private wireEngineEvents(): void {
    this.engine.on('connected', () => {
      this.send(IPC_CHANNELS.CONNECTION_STATUS, 'connected');
    });

    this.engine.on('disconnected', () => {
      this.send(IPC_CHANNELS.CONNECTION_STATUS, 'disconnected');
    });

    this.engine.on('error', (err: Error) => {
      this.send(IPC_CHANNELS.CONNECTION_STATUS, 'error');
      this.send(IPC_CHANNELS.ERROR, { message: err.message });
    });

    this.engine.on('statusChanged', (status: string) => {
      this.send(IPC_CHANNELS.POLL_STATUS, status);
    });

    this.engine.on('cycleComplete', (cycle: number, elapsed: number) => {
      this.send(IPC_CHANNELS.CYCLE_COMPLETE, { cycle, elapsed });
    });
  }

  // ─── Renderer → Main (IPC handlers) ─────────────────────

  private wireIpcHandlers(): void {
    // Connect to device
    ipcMain.handle(IPC_CHANNELS.CONNECT, async (_event, target: DeviceTarget) => {
      try {
        await this.engine.connect(target);
        this.engine.start();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // Disconnect
    ipcMain.handle(IPC_CHANNELS.DISCONNECT, async () => {
      await this.engine.disconnect();
      this.state.reset();
      return { success: true };
    });

    // Start polling (if connected but stopped)
    ipcMain.handle(IPC_CHANNELS.START_POLLING, async () => {
      this.engine.start();
      return { success: true };
    });

    // Stop polling (keep connection)
    ipcMain.handle(IPC_CHANNELS.STOP_POLLING, async () => {
      this.engine.stop();
      return { success: true };
    });

    // Get full state snapshot
    ipcMain.handle(IPC_CHANNELS.GET_SNAPSHOT, async () => {
      return JSON.stringify(this.state.getSnapshot());
    });

    // Get history for a collection
    ipcMain.handle(IPC_CHANNELS.GET_HISTORY, async (_event, collection: 'cpu' | 'memory') => {
      return JSON.stringify(this.state.getHistory(collection));
    });

    // Get engine status
    ipcMain.handle(IPC_CHANNELS.GET_STATUS, async () => {
      return this.engine.status;
    });
  }

  // ─── Send to renderer ────────────────────────────────────

  private send(channel: string, data: any): void {
    try {
      if (!this.window.isDestroyed()) {
        this.window.webContents.send(channel, data);
      }
    } catch (err) {
      log.error(`Bridge send error (${channel}): ${err}`);
    }
  }

  // ─── Programmatic connect (CLI args, tests) ──────────

  /**
   * Connect to a device directly from the main process.
   * Used for CLI --connect args and automated testing.
   * Same logic as the IPC CONNECT handler.
   */
  async connectToDevice(target: DeviceTarget): Promise<{ success: boolean; error?: string }> {
    try {
      await this.engine.connect(target);
      this.engine.start();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────

  async destroy(): Promise<void> {
    await this.engine.disconnect();

    // Remove IPC handlers
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }

    log.info('TelemetryBridge destroyed');
  }
}