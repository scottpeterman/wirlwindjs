/**
 * Whirlwind SSH Client — Main Client
 * Ported from Python SCNG SSH Client (scng/discovery/ssh/client.py)
 *
 * Invoke-shell only — no exec mode. Required for most network devices.
 * Wraps ssh2's event-driven model in async/await for automation use.
 *
 * Features ported from Python:
 * - Legacy device support (old ciphers/KEX)
 * - ANSI sequence filtering
 * - Sophisticated prompt detection
 * - Pagination disable (shotgun approach)
 * - Stale data drain before each command
 * - NetEmulate transparent redirect
 * - Context-manager pattern (using/dispose)
 *
 * Usage:
 *   const client = new WhirlwindSSHClient({
 *     host: '192.168.1.1',
 *     username: 'admin',
 *     password: 'secret',
 *     legacyMode: true,
 *   });
 *   await client.connect();
 *   const prompt = await client.findPrompt();
 *   client.setExpectPrompt(prompt);
 *   await client.disablePagination();
 *   const result = await client.executeCommand('show version');
 *   console.log(result.output);
 *   client.disconnect();
 *
 * Emulation:
 *   import { enableEmulation } from './emulation';
 *   await enableEmulation({ lookupPath: 'ip_lookup.json' });
 *   // Same code above — 192.168.1.1 routes to 127.0.0.1:10248
 */

import { Client as SSH2Client, ClientChannel, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { getLogger } from './logger';

import type {
  SSHClientConfig,
  ResolvedSSHClientConfig,
  CommandResult,
  WhirlwindEvents,
} from './types';
import { resolveConfig } from './types';
import { filterAnsiSequences, PAGINATION_DISABLE_SHOTGUN } from './filters';
import { getAlgorithms } from './legacy';
import {
  lookupEmulation,
  isEmulationEnabled,
  getEmulationHost,
  getEmulationCreds,
} from './emulation';

// ─── Typed EventEmitter ──────────────────────────────────────

export interface WhirlwindSSHClient {
  on<K extends keyof WhirlwindEvents>(event: K, listener: WhirlwindEvents[K]): this;
  off<K extends keyof WhirlwindEvents>(event: K, listener: WhirlwindEvents[K]): this;
  emit<K extends keyof WhirlwindEvents>(event: K, ...args: Parameters<WhirlwindEvents[K]>): boolean;
}

// ─── Main Client ─────────────────────────────────────────────

export class WhirlwindSSHClient extends EventEmitter {
  private config: ResolvedSSHClientConfig;
  private client: SSH2Client | null = null;
  private channel: ClientChannel | null = null;

  /** Internal receive buffer — data handler pushes here */
  private rxBuffer: string = '';

  /** Detected device prompt */
  private detectedPrompt: string | null = null;

  /** User-set expected prompt (overrides detected) */
  private expectPrompt: string | null = null;

  /** True if this connection was redirected to a mock device */
  private _emulated = false;

  /** Mock device hostname (if emulated) */
  private _emulatedDevice: string | null = null;

  /** Resolve function for the current waitForData promise */
  private dataResolver: (() => void) | null = null;

  /** Callback for event-driven prompt detection (set by waitForPrompt) */
  private promptChecker: (() => void) | null = null;

  constructor(config: SSHClientConfig) {
    super();
    this.config = resolveConfig(config);
  }

  // ─── Properties ──────────────────────────────────────────

  /** True if connected to a mock device via NetEmulate */
  get isEmulated(): boolean {
    return this._emulated;
  }

  /** Hostname of mock device (if emulated) */
  get emulatedDevice(): string | null {
    return this._emulatedDevice;
  }

  /** Detected or set prompt string */
  get prompt(): string | null {
    return this.expectPrompt ?? this.detectedPrompt;
  }

  /** Extract hostname from detected prompt */
  get hostname(): string | null {
    return this.extractHostnameFromPrompt();
  }

  /** Whether the client has an active shell channel */
  get isConnected(): boolean {
    return this.channel !== null && !this.channel.destroyed;
  }

  // ─── Connect ─────────────────────────────────────────────

  /**
   * Establish SSH connection and open interactive shell.
   *
   * In emulation mode, the target host/port are transparently
   * redirected to the mock device server based on ip_lookup.json.
   * Credentials are overridden to match the mock server.
   */
  async connect(): Promise<void> {
    // ── Emulation redirect ─────────────────────────────────
    const emu = lookupEmulation(this.config.host);
    if (emu) {
      const originalHost = this.config.host;
      const originalPort = this.config.port;

      this.config.host = getEmulationHost();
      this.config.port = emu.port;
      const [emuUser, emuPass] = getEmulationCreds();
      this.config.username = emuUser;
      this.config.password = emuPass;
      this.config.legacyMode = false; // Mock server doesn't need legacy
      this._emulated = true;
      this._emulatedDevice = emu.hostname;

      getLogger().info(
        `[EMULATION] ${originalHost}:${originalPort} -> ` +
        `${this.config.host}:${emu.port} (${emu.hostname})`
      );
      this.emit('emulated', emu.hostname);
    } else if (isEmulationEnabled()) {
      getLogger().warn(
        `[EMULATION] No mapping for ${this.config.host} — ` +
        `connecting directly (will likely fail)`
      );
    }

    // ── SSH2 connection ────────────────────────────────────
    getLogger().debug(`Connecting to ${this.config.host}:${this.config.port}`);

    this.client = new SSH2Client();

    const connectConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.config.timeout,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      algorithms: getAlgorithms(this.config.legacyMode),
    };

    // ── Auth: password ─────────────────────────────────────
    if (this.config.password) {
      connectConfig.password = this.config.password;
    }

    // ── Auth: key ──────────────────────────────────────────
    if (this.config.keyContent) {
      connectConfig.privateKey = this.config.keyContent;
      if (this.config.keyPassphrase) {
        connectConfig.passphrase = this.config.keyPassphrase;
      }
      getLogger().debug('Auth: private key from memory');
    } else if (this.config.keyFile) {
      const resolvedPath = this.config.keyFile.startsWith('~')
        ? path.join(os.homedir(), this.config.keyFile.slice(1))
        : this.config.keyFile;

      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Key file not found: ${resolvedPath}`);
      }
      connectConfig.privateKey = fs.readFileSync(resolvedPath);
      if (this.config.keyPassphrase) {
        connectConfig.passphrase = this.config.keyPassphrase;
      }
      getLogger().debug(`Auth: private key from ${resolvedPath}`);
    }

    // ── Keyboard-interactive handler ───────────────────────
    // Many network devices (especially behind Cisco ISE) force
    // keyboard-interactive even when password was already provided.
    this.client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
      getLogger().debug('keyboard-interactive auth — responding with password');
      finish([this.config.password ?? '']);
    });

    // ── Connect and open shell ─────────────────────────────
    return new Promise<void>((resolve, reject) => {
      if (!this.client) return reject(new Error('Client not initialized'));

      const onReady = async () => {
        cleanup();
        getLogger().debug(`Connected to ${this.config.host}`);
        this.emit('connected');

        try {
          await this.openShell();
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      const onError = (err: Error) => {
        cleanup();
        getLogger().error(`Connection error: ${err.message}`);
        this.emit('error', err);
        reject(err);
      };

      const cleanup = () => {
        this.client?.removeListener('ready', onReady);
        this.client?.removeListener('error', onError);
      };

      this.client.once('ready', onReady);
      this.client.once('error', onError);

      // Wire persistent close handler
      this.client.on('close', () => {
        getLogger().info('Connection closed');
        this.emit('disconnected');
      });

      this.client.connect(connectConfig);
    });
  }

  // ─── Shell ───────────────────────────────────────────────

  /**
   * Open interactive shell channel.
   *
   * Note: height=24 is required — some older IOS SSH implementations
   * (e.g., Cisco-1.25) reject or silently fail on height=0 PTY requests.
   * Pagination is handled by 'terminal length 0', not the PTY size.
   */
  private openShell(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.client) return reject(new Error('Not connected'));

      this.client.shell(
        { term: 'xterm', cols: 200, rows: 24 },
        (err, stream) => {
          if (err) return reject(new Error(`Failed to open shell: ${err.message}`));

          this.channel = stream;
          this.setupChannelHandlers(stream);

          getLogger().debug('Shell opened');

          // Wait for shell initialization
          const initDelay = this._emulated ? 300 : 2000;
          setTimeout(() => {
            this.drainOutput(); // Consume banner/MOTD
            resolve();
          }, initDelay);
        }
      );
    });
  }

  /**
   * Wire up data/close handlers on the shell channel.
   *
   * All incoming data is ANSI-filtered and pushed to rxBuffer.
   * The dataResolver callback (if set) is called when new data
   * arrives, allowing waitForPrompt to wake up.
   */
  private setupChannelHandlers(stream: ClientChannel): void {
    stream.on('data', (data: Buffer) => {
      const text = filterAnsiSequences(data.toString('utf-8'));
      this.rxBuffer += text;
      this.emit('data', text);

      // Wake any pending waitForData
      if (this.dataResolver) {
        this.dataResolver();
        this.dataResolver = null;
      }

      // Check prompt for event-driven waitForPrompt
      if (this.promptChecker) {
        this.promptChecker();
      }
    });

    stream.stderr.on('data', (data: Buffer) => {
      const text = filterAnsiSequences(data.toString('utf-8'));
      this.rxBuffer += text;
      this.emit('data', text);

      if (this.dataResolver) {
        this.dataResolver();
        this.dataResolver = null;
      }

      if (this.promptChecker) {
        this.promptChecker();
      }
    });

    stream.on('close', () => {
      getLogger().debug('Shell channel closed');
      this.channel = null;
    });
  }

  // ─── Buffer Management ───────────────────────────────────

  /**
   * Read and clear the receive buffer.
   * Equivalent to Python's _drain_output().
   */
  private drainOutput(): string {
    const data = this.rxBuffer;
    this.rxBuffer = '';
    return data;
  }

  /**
   * Wait for new data to arrive in the buffer.
   * Returns when NEW data arrives or timeout expires.
   *
   * IMPORTANT: Does NOT resolve early on existing buffer content.
   * The old version checked rxBuffer.length > 0 and resolved immediately,
   * which caused a tight spin loop in waitForPrompt — the buffer always
   * had stale content (command echo), so waitForData never yielded to
   * the I/O event queue, and ssh2 data callbacks never fired.
   */
  private waitForData(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.dataResolver = null;
        resolve();
      }, timeoutMs);

      this.dataResolver = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // ─── Prompt Detection ────────────────────────────────────

  /**
   * Detect the device prompt.
   *
   * Sends newlines and observes what comes back.
   * Polls buffer at short intervals (50ms) instead of sleeping
   * the full shellTimeout — prompt typically arrives within 100-500ms,
   * so we detect it much faster while still allowing the full timeout
   * for slow devices.
   *
   * Faster timeouts in emulation mode since mock devices respond instantly.
   */
  async findPrompt(attemptCount?: number, timeout?: number): Promise<string> {
    let attempts = attemptCount ?? this.config.promptCount;
    let waitMs = timeout ?? this.config.shellTimeout;

    // Mock devices respond instantly — no need to wait
    if (this._emulated) {
      attempts = Math.min(attempts, 2);
      waitMs = Math.min(waitMs, 1000);
    }

    const promptsSeen: string[] = [];
    const pollInterval = 50; // Check every 50ms

    for (let i = 0; i < attempts; i++) {
      // Drain stale
      this.drainOutput();

      // Send newline
      this.send('\n');

      // Poll buffer at short intervals instead of sleeping full waitMs
      const deadline = Date.now() + waitMs;
      let buffer = '';
      while (Date.now() < deadline) {
        await this.waitForData(Math.min(pollInterval, deadline - Date.now()));
        buffer = this.rxBuffer; // Peek — don't drain yet
        if (buffer.trim()) {
          // Got something — check if it looks like a prompt
          const prompt = this.extractPrompt(buffer);
          if (prompt) {
            // Brief settle for trailing bytes
            await this.sleep(50);
            buffer = this.drainOutput();
            break;
          }
        }
      }

      // Final drain if we timed out
      if (this.rxBuffer.length > 0) {
        buffer = this.drainOutput();
      }

      if (buffer) {
        const prompt = this.extractPrompt(buffer);
        if (prompt) {
          promptsSeen.push(prompt);
        }
      }
    }

    if (promptsSeen.length > 0) {
      // Use most common prompt (same logic as Python)
      const freq = new Map<string, number>();
      for (const p of promptsSeen) {
        freq.set(p, (freq.get(p) ?? 0) + 1);
      }
      const prompt = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];

      this.detectedPrompt = prompt;
      getLogger().debug(`Detected prompt: ${JSON.stringify(prompt)}`);
      this.emit('prompt', prompt);
      return prompt;
    }

    // Fallback
    getLogger().warn("Could not detect prompt, using '#' fallback");
    this.detectedPrompt = '#';
    return '#';
  }

  /**
   * Extract prompt from buffer content.
   * Same heuristics as Python — regex patterns, length checks, repetition handling.
   */
  private extractPrompt(buffer: string): string | null {
    if (!buffer?.trim()) return null;

    const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;

    // Prompt patterns — ordered by specificity
    const patterns = [
      /([A-Za-z0-9\-_.@()]+[#>$%])\s*$/,  // Standard network prompts
      /([^\r\n]+[#>$%])\s*$/,               // Anything ending with prompt char
    ];

    const commonEndings = ['#', '>', '$', '%', ':', ']', ')'];

    // Check last lines for prompt
    const candidates = lines.slice(-5).reverse();
    for (const line of candidates) {
      // Skip lines too long (probably output, not prompt)
      if (line.length > 60) continue;

      // Try regex patterns
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          const prompt = match[1].trim();
          // Handle repeated prompts (e.g., "router# router# router#")
          const base = this.extractBasePrompt(prompt);
          return base ?? prompt;
        }
      }

      // Check for common endings
      if (commonEndings.some((c) => line.endsWith(c)) && line.length < 40) {
        return line;
      }
    }

    return null;
  }

  /**
   * Extract base prompt from potentially repeated text.
   * Handles "router# router# router#" → "router#"
   */
  private extractBasePrompt(text: string): string | null {
    for (const ending of ['#', '>', '$', '%']) {
      if (text.includes(ending)) {
        const parts = text.split(ending);
        if (parts.length > 2) {
          const base = parts[0].trim() + ending;
          if (base.length < 40) return base;
        }
      }
    }
    return null;
  }

  /**
   * Extract hostname from detected prompt.
   *
   * Handles common formats:
   * - Cisco/Arista/Juniper: "hostname#" or "hostname>"
   * - Linux: "user@hostname:~$" or "user@hostname $"
   * - Juniper: "user@hostname>"
   */
  extractHostnameFromPrompt(prompt?: string): string | null {
    const p = prompt ?? this.detectedPrompt;
    if (!p) return null;

    // Linux style: user@hostname:path$ or user@hostname$
    const linuxMatch = p.match(/^[^@]+@([A-Za-z0-9\-_.]+)/);
    if (linuxMatch) return linuxMatch[1];

    // Network device style: hostname# or hostname> or hostname(config)#
    const cleanPrompt = p.replace(/\([^)]+\)/, '');
    const deviceMatch = cleanPrompt.match(/^([A-Za-z0-9\-_.]+)[#>$%:\]]/);
    if (deviceMatch) return deviceMatch[1];

    return null;
  }

  // ─── Prompt & Pagination ─────────────────────────────────

  /**
   * Set the prompt string to expect after commands.
   */
  setExpectPrompt(prompt: string): void {
    this.expectPrompt = prompt;
    getLogger().debug(`Expect prompt set to: ${JSON.stringify(prompt)}`);
  }

  /**
   * Disable pagination by trying common commands.
   *
   * Fires multiple vendor commands — wrong ones just produce errors
   * that are drained and discarded. Each command is followed by a
   * findPrompt() to confirm the shell returned to a clean state.
   *
   * Skipped entirely in emulation mode — mock devices don't paginate.
   */
  async disablePagination(): Promise<void> {
    if (this._emulated) {
      getLogger().debug('[EMULATION] Skipping pagination disable (mock device)');
      return;
    }

    getLogger().debug('Disabling pagination (shotgun approach)');

    for (const cmd of PAGINATION_DISABLE_SHOTGUN) {
      try {
        this.send(cmd + '\n');
        // Confirm prompt returns — consumes any error output
        // and validates the shell is ready for the next command.
        // 1.5s is plenty — pagination responses are instant.
        await this.findPrompt(1, 1500);
      } catch (e) {
        getLogger().debug(`Pagination cmd failed (expected): ${cmd} — ${e}`);
      }
    }

    // Final prompt check — confirm clean shell state
    const prompt = await this.findPrompt(2, 1500);
    getLogger().debug(`Pagination disable complete, prompt=${JSON.stringify(prompt)}`);
  }

  // ─── Command Execution ───────────────────────────────────

  /**
   * Execute command and return output.
   *
   * Supports comma-separated commands (same as Python client).
   * Drains stale data before each command to prevent the
   * one-command-offset desync bug.
   *
   * @param command - Command string. Can be comma-separated for multiple.
   * @param timeout - Override default timeout (ms).
   * @returns CommandResult with output, timing, and prompt detection flag.
   */
  async executeCommand(command: string, timeout?: number): Promise<CommandResult> {
    if (!this.channel || this.channel.destroyed) {
      throw new Error('Not connected');
    }

    const timeoutMs = timeout ?? this.config.expectPromptTimeout;
    const startTime = Date.now();

    // Split comma-separated commands
    const commands = command
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    let fullOutput = '';
    let promptDetected = false;

    for (const cmd of commands) {
      if (cmd === '\\n' || cmd === '\n') {
        this.send('\n');
        await this.sleep(100);
        continue;
      }

      // ── Drain stale data before sending ────────────────
      // Between poll cycles, the channel may accumulate trailing
      // bytes from the previous command (post-prompt newlines,
      // late-arriving output fragments). Without draining, the
      // next waitForPrompt reads stale data first, finds the
      // *previous* command's prompt, and returns immediately
      // with garbage — causing a one-command offset desync.
      const stale = this.drainOutput();
      if (stale) {
        getLogger().debug(`Drained ${stale.length} chars of stale data before '${cmd}'`);
      }

      getLogger().debug(`Sending: ${cmd}`);
      this.send(cmd + '\n');

      // Wait for prompt
      const result = await this.waitForPrompt(timeoutMs);
      fullOutput += result.output;
      promptDetected = result.promptDetected;

      // Inter-command delay
      const delay = this._emulated ? 50 : this.config.interCommandTime;
      await this.sleep(delay);
    }

    return {
      output: fullOutput,
      command,
      promptDetected,
      elapsed: Date.now() - startTime,
    };
  }

  /**
   * Wait for prompt to appear in output.
   *
   * Event-driven approach: registers a callback that fires on every
   * incoming data chunk and checks whether the prompt has appeared.
   * No polling loop — the ssh2 data event drives resolution directly.
   *
   * This replaces the old poll-based approach which had a critical bug:
   * waitForData() resolved immediately when rxBuffer had any content
   * (including stale command echo), creating a tight spin loop that
   * never yielded to the I/O event queue. Data arrived on the socket
   * but Node never processed the ssh2 callbacks before the timeout.
   *
   * Python equivalent: _wait_for_prompt() with recv_ready()/recv()
   * in a 10ms sleep loop. Here we do better — zero-latency wakeup
   * on every data chunk.
   */
  private async waitForPrompt(
    timeoutMs: number
  ): Promise<{ output: string; promptDetected: boolean }> {
    const prompt = this.expectPrompt ?? this.detectedPrompt;

    if (!prompt) {
      // No prompt detection — just wait and read
      await this.sleep(this.config.shellTimeout);
      return { output: this.drainOutput(), promptDetected: false };
    }

    // ── Check buffer immediately (prompt may already be there) ──
    if (this.rxBuffer.includes(prompt)) {
      getLogger().debug('Prompt detected in output (immediate)');
      await this.sleep(50); // settle — catch trailing bytes
      return { output: this.drainOutput(), promptDetected: true };
    }

    // ── Event-driven wait ───────────────────────────────────────
    return new Promise<{ output: string; promptDetected: boolean }>((resolve) => {
      let settled = false;

      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.promptChecker = null;
        getLogger().warn(`Timeout waiting for prompt after ${timeoutMs}ms`);
        resolve({ output: this.drainOutput(), promptDetected: false });
      }, timeoutMs);

      // Called from setupChannelHandlers on every data chunk
      this.promptChecker = () => {
        if (settled) return;
        if (this.rxBuffer.includes(prompt)) {
          settled = true;
          clearTimeout(deadline);
          this.promptChecker = null;
          getLogger().debug('Prompt detected in output');
          // Settle delay — some devices send trailing bytes after prompt
          setTimeout(() => {
            resolve({ output: this.drainOutput(), promptDetected: true });
          }, 50);
        }
      };
    });
  }

  // ─── Low-level I/O ──────────────────────────────────────

  /**
   * Send raw data to the shell channel.
   */
  send(data: string): void {
    if (!this.channel || this.channel.destroyed) {
      throw new Error('Not connected');
    }
    this.channel.write(data);
  }

  // ─── Disconnect ─────────────────────────────────────────

  /**
   * Close SSH connection and clean up.
   */
  disconnect(): void {
    if (this._emulated) {
      getLogger().debug(`[EMULATION] Disconnecting from mock device ${this._emulatedDevice}`);
    }

    if (this.channel) {
      try {
        this.channel.close();
      } catch (e) {
        getLogger().debug(`Shell close error: ${e}`);
      }
      this.channel = null;
    }

    if (this.client) {
      try {
        this.client.end();
      } catch (e) {
        getLogger().debug(`Client close error: ${e}`);
      }
      this.client = null;
    }

    this.rxBuffer = '';
    this.dataResolver = null;
    this.promptChecker = null;
    getLogger().debug(`Disconnected from ${this.config.host}`);
  }

  // ─── Utilities ──────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Disposable (using pattern) ─────────────────────────

  async [Symbol.asyncDispose](): Promise<void> {
    this.disconnect();
  }
}