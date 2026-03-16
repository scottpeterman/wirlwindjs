/**
 * Wirlwind Telemetry — State Store
 * Ported from Python state_store.py
 *
 * In-memory store for current collection data and history ring buffers.
 * Emits change events for the bridge to forward to the renderer.
 */

import { EventEmitter } from 'events';
import log from 'electron-log';
import type {
  ParsedResult,
  DeviceInfo,
  TelemetryState,
  HistoryEntry,
  PollConfig,
  DEFAULT_POLL_CONFIG,
} from '../shared/types';

export class StateStore extends EventEmitter {
  private collections: Record<string, ParsedResult> = {};
  private device: DeviceInfo | null = null;
  private cpuHistory: HistoryEntry[] = [];
  private memHistory: HistoryEntry[] = [];
  private maxHistory: number;

  constructor(maxHistory = 720) {
    super();
    this.maxHistory = maxHistory;
  }

  // ─── Collection State ────────────────────────────────────

  updateCollection(name: string, data: ParsedResult): void {
    this.collections[name] = data;
    this.emit('stateChanged', name, data);

    // Track history for cpu and memory
    const now = Math.floor(Date.now() / 1000);

    if (name === 'cpu' && data._parsed_by !== 'none') {
      this.cpuHistory.push({ timestamp: now, data: { ...data } });
      if (this.cpuHistory.length > this.maxHistory) {
        this.cpuHistory.shift();
      }
    }

    if (name === 'memory' && data._parsed_by !== 'none') {
      this.memHistory.push({ timestamp: now, data: { ...data } });
      if (this.memHistory.length > this.maxHistory) {
        this.memHistory.shift();
      }
    }
  }

  getCollection(name: string): ParsedResult | null {
    return this.collections[name] ?? null;
  }

  // ─── Device Info ─────────────────────────────────────────

  setDeviceInfo(info: DeviceInfo): void {
    this.device = info;
    this.emit('deviceInfoChanged', info);
  }

  getDeviceInfo(): DeviceInfo | null {
    return this.device;
  }

  // ─── History ─────────────────────────────────────────────

  getHistory(collection: 'cpu' | 'memory'): HistoryEntry[] {
    return collection === 'cpu' ? this.cpuHistory : this.memHistory;
  }

  // ─── Snapshot (full state for initial load / polling) ────

  getSnapshot(): TelemetryState {
    return {
      collections: { ...this.collections },
      device: this.device ?? { ip: '', vendor: 'cisco_ios' },
      history: {
        cpu: this.cpuHistory,
        memory: this.memHistory,
      },
    };
  }

  // ─── Reset ───────────────────────────────────────────────

  reset(): void {
    this.collections = {};
    this.device = null;
    this.cpuHistory = [];
    this.memHistory = [];
    log.info('State store reset');
  }
}