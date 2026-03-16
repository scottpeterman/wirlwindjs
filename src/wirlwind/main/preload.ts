/**
 * Wirlwind Telemetry — Preload Script
 *
 * Exposes a clean API to the renderer via contextBridge.
 * This replaces QWebChannel's bridge object.
 *
 * Python (QWebChannel):
 *   bridge.stateChanged.connect(callback)
 *   bridge.getSnapshot() → JSON string
 *
 * Electron (contextBridge):
 *   window.wirlwind.onStateChanged(callback)
 *   window.wirlwind.getSnapshot() → Promise<JSON string>
 */

import { contextBridge, ipcRenderer } from 'electron';

const IPC = {
  CONNECT: 'wt:connect',
  DISCONNECT: 'wt:disconnect',
  START_POLLING: 'wt:start-polling',
  STOP_POLLING: 'wt:stop-polling',
  GET_SNAPSHOT: 'wt:get-snapshot',
  GET_HISTORY: 'wt:get-history',
  GET_STATUS: 'wt:get-status',

  STATE_CHANGED: 'wt:state-changed',
  CYCLE_COMPLETE: 'wt:cycle-complete',
  CONNECTION_STATUS: 'wt:connection-status',
  DEVICE_INFO: 'wt:device-info',
  POLL_STATUS: 'wt:poll-status',
  ERROR: 'wt:error',
};

contextBridge.exposeInMainWorld('wirlwind', {
  // ─── Commands (Renderer → Main) ──────────────────────────
  connect: (target: any) => ipcRenderer.invoke(IPC.CONNECT, target),
  disconnect: () => ipcRenderer.invoke(IPC.DISCONNECT),
  startPolling: () => ipcRenderer.invoke(IPC.START_POLLING),
  stopPolling: () => ipcRenderer.invoke(IPC.STOP_POLLING),
  getSnapshot: () => ipcRenderer.invoke(IPC.GET_SNAPSHOT),
  getHistory: (collection: string) => ipcRenderer.invoke(IPC.GET_HISTORY, collection),
  getStatus: () => ipcRenderer.invoke(IPC.GET_STATUS),

  // ─── Events (Main → Renderer) ────────────────────────────
  onStateChanged: (callback: (collection: string, data: any) => void) => {
    ipcRenderer.on(IPC.STATE_CHANGED, (_event, payload) => {
      callback(payload.collection, payload.data);
    });
  },

  onCycleComplete: (callback: () => void) => {
    ipcRenderer.on(IPC.CYCLE_COMPLETE, () => callback());
  },

  onConnectionStatus: (callback: (status: string) => void) => {
    ipcRenderer.on(IPC.CONNECTION_STATUS, (_event, status) => callback(status));
  },

  onDeviceInfo: (callback: (info: any) => void) => {
    ipcRenderer.on(IPC.DEVICE_INFO, (_event, info) => callback(info));
  },

  onPollStatus: (callback: (status: string) => void) => {
    ipcRenderer.on(IPC.POLL_STATUS, (_event, status) => callback(status));
  },

  onError: (callback: (error: any) => void) => {
    ipcRenderer.on(IPC.ERROR, (_event, error) => callback(error));
  },

  // ─── Cleanup ─────────────────────────────────────────────
  removeAllListeners: () => {
    for (const channel of Object.values(IPC)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
});