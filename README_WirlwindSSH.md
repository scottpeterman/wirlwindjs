# Whirlwind SSH

Network device SSH automation for TypeScript/Node.js — ported from the battle-tested Python SCNG SSH Client. Works in Node.js, Electron, and any TypeScript environment.

## Why This Exists

The Python SCNG SSH Client (`scng/discovery/ssh/client.py`) has been proven against 357+ devices across 53 sites. This is a faithful TypeScript port using `ssh2` for use in Electron apps (nterm-js, wirlwind-js), preserving every hard-won behavior:

- **Invoke-shell only** — exec mode is a trap that works on two vendors
- **Legacy cipher/KEX support** — old IOS, JunOS, EOS with legacy-first algorithm ordering
- **ANSI sequence filtering** — clean output from dirty devices
- **Prompt detection** — heuristic-based, handles repeated prompts, 383ms typical
- **Pagination shotgun** — fires all vendor disable commands, wrong ones fail harmlessly
- **Stale data drain** — prevents the one-command-offset desync bug
- **Event-driven prompt detection** — zero-latency wakeup on ssh2 data events
- **NetEmulate integration** — transparent mock device redirect for testing

## Usage

```typescript
import { WhirlwindSSHClient, enableEmulation, setLogger } from 'whirlwind-ssh';

// ─── Logger (optional — defaults to console) ─────────────
import log from 'electron-log';
setLogger(log);

// ─── Basic automation ────────────────────────────────────
const client = new WhirlwindSSHClient({
  host: '192.168.1.1',
  username: 'admin',
  password: 'secret',
  legacyMode: true,
});

await client.connect();
const prompt = await client.findPrompt();
client.setExpectPrompt(prompt);
await client.disablePagination();

const result = await client.executeCommand('show version');
console.log(result.output);
console.log(`Hostname: ${client.hostname}`);

client.disconnect();

// ─── Key-based auth ──────────────────────────────────────
const keyClient = new WhirlwindSSHClient({
  host: '10.0.0.1',
  username: 'netops',
  keyFile: '~/.ssh/id_ed25519',
});

// ─── In-memory key (from vault/secrets manager) ──────────
const vaultClient = new WhirlwindSSHClient({
  host: '10.0.0.1',
  username: 'netops',
  keyContent: pemStringFromVault,
  keyPassphrase: 'encrypted-key-pass',
});

// ─── Multiple commands ───────────────────────────────────
const result = await client.executeCommand(
  'show ip bgp summary, show ip route summary'
);

// ─── Emulation mode (NetEmulate mock devices) ────────────
await enableEmulation({ lookupPath: '/path/to/ip_lookup.json' });
// 192.168.1.1 -> 127.0.0.1:10248

// ─── Events ─────────────────────────────────────────────
client.on('data', (text) => process.stdout.write(text));
client.on('prompt', (p) => console.log(`Prompt: ${p}`));
client.on('emulated', (device) => console.log(`Mock: ${device}`));
```

## Configuration

```typescript
interface SSHClientConfig {
  host: string;
  username: string;
  password?: string;
  keyContent?: string;       // PEM key as string (in-memory, no disk)
  keyFile?: string;
  keyPassphrase?: string;
  port?: number;             // Default: 22
  timeout?: number;          // Connection timeout ms (default: 30000)
  shellTimeout?: number;     // Shell read timeout ms (default: 3000)
  interCommandTime?: number; // Delay between commands ms (default: 1000)
  expectPromptTimeout?: number; // Command prompt timeout ms (default: 30000)
  promptCount?: number;      // Prompt detection attempts (default: 3)
  legacyMode?: boolean;      // Legacy cipher/KEX support (default: false)
  debug?: boolean;           // Debug logging (default: false)
}
```

## Python Parity

| Python (SCNG SSH Client)       | TypeScript (Whirlwind SSH)         |
|--------------------------------|------------------------------------|
| `SSHClientConfig` dataclass    | `SSHClientConfig` interface        |
| `SSHClient(config)`            | `new WhirlwindSSHClient(config)`   |
| `client.connect()`             | `await client.connect()`           |
| `client.find_prompt()`         | `await client.findPrompt()`        |
| `client.set_expect_prompt(p)`  | `client.setExpectPrompt(p)`        |
| `client.disable_pagination()`  | `await client.disablePagination()` |
| `client.execute_command(cmd)`  | `await client.executeCommand(cmd)` |
| `client.disconnect()`          | `client.disconnect()`              |
| `client.hostname`              | `client.hostname`                  |
| `client.is_emulated`           | `client.isEmulated`                |
| `enable_emulation(path)`       | `await enableEmulation({...})`     |
| `disable_emulation()`          | `disableEmulation()`               |
| `filter_ansi_sequences(text)`  | `filterAnsiSequences(text)`        |

## Architecture

```
whirlwind-ssh/
├── src/
│   ├── index.ts        # Barrel exports
│   ├── client.ts       # WhirlwindSSHClient (main)
│   ├── types.ts        # Interfaces, config resolution, defaults
│   ├── types-ssh.ts    # Alternate defaults (30s command timeout)
│   ├── filters.ts      # ANSI filtering, pagination constants
│   ├── legacy.ts       # Legacy/modern algorithm sets
│   ├── logger.ts       # Abstract logger (console default)
│   └── emulation.ts    # NetEmulate transparent redirect
├── package.json
└── tsconfig.json
```

## Key Design Decisions

### Event-driven prompt detection (not polling)

Python's `recv_ready()` + `recv()` work in a tight loop because `time.sleep(0.01)` yields to the OS scheduler. A naive TypeScript port using `while` + `await sleep()` to poll `rxBuffer` creates a subtle event loop starvation bug — if the buffer already has content (like the command echo), the poll loop never yields to macrotasks, and ssh2's `stream.on('data')` callbacks never fire.

The fix: `waitForPrompt()` registers a `promptChecker` callback that fires directly from the ssh2 data handler on every incoming chunk. When the prompt string appears in `rxBuffer`, it resolves the Promise immediately. No polling, no timer, zero-latency wakeup.

```
Python (paramiko)                    TypeScript (ssh2)
─────────────────                    ──────────────────
while time < deadline:               promptChecker = () => {
  if shell.recv_ready():               if rxBuffer.includes(prompt):
    chunk = recv()                       resolve({ output, true })
    if prompt in output:             }
      return output                  stream.on('data', () => {
  time.sleep(0.01)                     rxBuffer += chunk
                                       promptChecker?.()
                                     })
                                     setTimeout(reject, timeout)
```

### Electron algorithm compatibility

When `legacyMode` is false, `getAlgorithms()` returns `undefined` — letting ssh2 use its own defaults that are self-consistent with whatever crypto backend the runtime ships. This matters because Electron bundles its own OpenSSL which doesn't support all algorithms that system Node.js does (e.g., `chacha20-poly1305@openssh.com`). When `legacyMode` is true, legacy algorithms (diffie-hellman-group1-sha1, aes128-cbc, ssh-rsa) are listed first with modern fallbacks.

### Stale drain before every command

Ported directly from the Python client. Without this, late-arriving bytes from the previous command cause `waitForPrompt()` to find the old prompt and return immediately — the one-command-offset desync bug.

### Settle delay after prompt detection

50ms pause after finding the prompt, then one more buffer read. Catches trailing newlines and control characters that some devices send after the prompt.

### `keyboard-interactive` auto-response

Many devices (especially behind Cisco ISE) force keyboard-interactive auth even when a password was provided. The handler auto-responds with the stored password.

## Verified Performance (Arista vEOS, March 2026)

```
Connect:              2,389ms  (SSH handshake + keyboard-interactive)
Prompt detection:       383ms  (3 attempts, event-driven polling)
Pagination disable:     615ms  (8 vendor commands + 9 prompt checks)
show version:         1,066ms  (499 chars, prompt detected)
show clock:           1,273ms  (84 chars, prompt detected)
```

## License

MIT