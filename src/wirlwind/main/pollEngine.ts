/**
 * Wirlwind Telemetry — Poll Engine
 * Ported from Python poll_engine.py
 *
 * Manages the polling lifecycle:
 * 1. Connect to device via SSH (whirlwind-ssh)
 * 2. Detect prompt, disable pagination
 * 3. Loop: execute collection commands → parse → update state store
 * 4. Emit cycle-complete events for the UI
 *
 * The engine runs collections sequentially within each cycle
 * to avoid overwhelming the device with concurrent commands.
 */

import { EventEmitter } from 'events';
import log from 'electron-log';
import type {
  DeviceTarget,
  CollectionDef,
  PollConfig,
  PollStatus,
  VendorType,
  ParsedResult,
} from '../shared/types';
import { DEFAULT_POLL_CONFIG } from '../shared/types';
import { StateStore } from './stateStore';
import { parseWithTrace } from './parserChain';
import { loadAllCollections } from './collectionLoader';
import { getDriver, defaultShapeOutput } from './drivers';

/** Lowercase all keys in a dict (and nested arrays of dicts). Matches Python TextFSM behavior. */
function lowercaseKeys(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lk = key.toLowerCase();
    if (Array.isArray(value)) {
      result[lk] = value.map(item =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? lowercaseKeys(item)
          : item
      );
    } else {
      result[lk] = value;
    }
  }
  return result;
}

// ─── SSH Client ──────────────────────────────────────────────
// Import whirlwind-ssh — either as local module or npm package
// For now, inline the import path. Adjust when whirlwind-ssh is published.
let WhirlwindSSHClient: any;
let sshSetLogger: any;
try {
  const wsh = require('../../wirlwindssh');
  WhirlwindSSHClient = wsh.WhirlwindSSHClient;
  sshSetLogger = wsh.setLogger;
} catch {
  log.error('wirlwindssh not found — SSH polling disabled');
}

export class PollEngine extends EventEmitter {
  private state: StateStore;
  private config: PollConfig;
  private client: any = null;                         // WhirlwindSSHClient
  private target: DeviceTarget | null = null;
  private collections: Record<string, CollectionDef> = {};
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _status: PollStatus = 'idle';
  private cycleCount = 0;

  constructor(state: StateStore, config?: Partial<PollConfig>) {
    super();
    this.state = state;
    this.config = { ...DEFAULT_POLL_CONFIG, ...config };

    // Route whirlwind-ssh logs through electron-log
    if (sshSetLogger) {
      sshSetLogger({
        debug: (msg: string) => log.debug(`[SSH] ${msg}`),
        info: (msg: string) => log.info(`[SSH] ${msg}`),
        warn: (msg: string) => log.warn(`[SSH] ${msg}`),
        error: (msg: string) => log.error(`[SSH] ${msg}`),
      });
    }
  }

  get status(): PollStatus {
    return this._status;
  }

  private setStatus(status: PollStatus): void {
    this._status = status;
    this.emit('statusChanged', status);
  }

  // ─── Connect ─────────────────────────────────────────────

  async connect(target: DeviceTarget): Promise<void> {
    if (!WhirlwindSSHClient) {
      throw new Error('whirlwind-ssh not available');
    }

    this.target = target;
    this.setStatus('connecting' as any);

    // Load collection definitions for this vendor
    this.collections = loadAllCollections(target.vendor);
    log.info(`Loaded ${Object.keys(this.collections).length} collections for ${target.vendor}`);

    // Create SSH client
    this.client = new WhirlwindSSHClient({
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      password: target.password,
      keyFile: target.keyFile,
      keyContent: target.keyContent,
      keyPassphrase: target.keyPassphrase,
      legacyMode: target.legacyMode ?? false,
    });

    try {
      await this.client.connect();
      const prompt = await this.client.findPrompt();
      this.client.setExpectPrompt(prompt);
      await this.client.disablePagination();

      // Run post-connect commands (enable mode, etc.)
      const driver = getDriver(target.vendor);
      if (driver?.postConnectCommands) {
        for (const cmd of driver.postConnectCommands) {
          await this.client.executeCommand(cmd);
        }
      }

      // Set device info
      const hostname = this.client.hostname ?? target.host;
      this.state.setDeviceInfo({
        hostname,
        ip: target.host,
        vendor: target.vendor,
        username: target.username,
        tags: target.tags,
      });

      this.emit('connected');
      log.info(`Connected to ${target.host} (${hostname})`);
    } catch (err) {
      this.setStatus('error');
      this.emit('error', err);
      throw err;
    }
  }

  // ─── Poll Loop ───────────────────────────────────────────

  start(): void {
    if (!this.client?.isConnected) {
      log.error('Cannot start polling — not connected');
      return;
    }

    this.setStatus('polling');
    log.info(`Polling started (${this.config.intervalSeconds}s interval)`);

    // Run first cycle immediately
    this.runCycle();
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.setStatus('idle');
    log.info('Polling stopped');
  }

  async disconnect(): Promise<void> {
    this.stop();

    if (this.client) {
      try {
        this.client.disconnect();
      } catch (e) {
        log.debug(`Disconnect error: ${e}`);
      }
      this.client = null;
    }

    this.target = null;
    this.setStatus('disconnected');
    this.emit('disconnected');
  }

  // ─── Single Poll Cycle ───────────────────────────────────

  private async runCycle(): Promise<void> {
    if (this._status !== 'polling') return;
    if (!this.client?.isConnected) {
      this.setStatus('error');
      this.emit('error', new Error('SSH connection lost'));
      return;
    }

    const cycleStart = Date.now();
    this.cycleCount++;
    log.debug(`Poll cycle ${this.cycleCount} starting`);

    const driver = getDriver(this.target!.vendor);

    // Filter to configured collections
    const collectionsToRun = this.config.collections.filter(
      (name) => this.collections[name]
    );

    for (const name of collectionsToRun) {
      try {
        const def = this.collections[name];
        if (!def) continue;

        // Execute command
        const result = await this.client.executeCommand(
          def.command,
          def.timeout ?? undefined
        );

        // Parse output
        const { result: parsed, trace } = parseWithTrace(
          result.output,
          def,
          name
        );

        // Shape output: convert TextFSM entries[] array into the dict
        // structure drivers and the dashboard expect.
        // Single-row collections (cpu, memory) → flat dict
        // Multi-row collections (interfaces, neighbors) → { listKey: [rows] }
        let shaped: Record<string, any> = { ...parsed };
        if (parsed.entries && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
          const rows = parsed.entries as Record<string, any>[];
          const shapeData = driver
            ? driver.shapeOutput(name, rows)
            : defaultShapeOutput(name, rows);
          // Merge shape result with parser metadata
          shaped = {
            ...shapeData,
            _parsed_by: parsed._parsed_by,
            _template: parsed._template,
          };
        }
              shaped = lowercaseKeys(shaped);

        // Post-process via vendor driver
        const processed = driver
          ? driver.postProcess(name, shaped)
          : shaped;

        // Update state
        this.state.updateCollection(name, processed as ParsedResult);

        if (trace.success) {
          log.debug(`[${name}] OK (${trace.parser}, ${trace.elapsed}ms)`);
        } else {
          log.warn(`[${name}] Parse failed: ${trace.error}`);
        }
      } catch (err) {
        log.error(`[${name}] Collection error: ${err}`);
        this.state.updateCollection(name, {
          _parsed_by: 'none',
          _error: String(err),
        });
      }
    }

    // Emit cycle complete
    const elapsed = Date.now() - cycleStart;
    log.debug(`Poll cycle ${this.cycleCount} complete (${elapsed}ms)`);
    this.emit('cycleComplete', this.cycleCount, elapsed);

    // Schedule next cycle
    if (this._status === 'polling') {
      this.pollTimer = setTimeout(
        () => this.runCycle(),
        this.config.intervalSeconds * 1000
      );
    }
  }
}