# Whirlwind SSH

Network device SSH automation for TypeScript/Node.js — ported from the battle-tested Python SCNG SSH Client. Works in Node.js, Electron, and any TypeScript environment.

## Why This Exists

The Python SCNG SSH Client (`scng/discovery/ssh/client.py`) has been proven against 357+ devices across 53 sites. This is a faithful TypeScript port using `ssh2` for use in Electron apps (nterm.js), preserving every hard-won behavior:

- **Invoke-shell only** — exec mode is a trap that works on two vendors
- **Legacy cipher/KEX support** — old IOS, JunOS, EOS
- **ANSI sequence filtering** — clean output from dirty devices
- **Prompt detection** — heuristic-based, handles repeated prompts
- **Pagination shotgun** — fires all vendor disable commands, wrong ones fail harmlessly
- **Stale data drain** — prevents the one-command-offset desync bug
- **NetEmulate integration** — transparent mock device redirect for testing

## Usage

```typescript
import { WhirlwindSSHClient, enableEmulation, setLogger } from 'whirlwind-ssh';

// ─── Logger (optional — defaults to console) ─────────────
// Electron:
import log from 'electron-log';
setLogger(log);

// Pino:
import pino from 'pino';
setLogger(pino());

// Silent (tests):
import { SILENT_LOGGER } from 'whirlwind-ssh';
setLogger(SILENT_LOGGER);

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
// Now the same code connects to mock devices transparently
// 192.168.1.1 -> 127.0.0.1:10248

// ─── Events ─────────────────────────────────────────────
client.on('data', (text) => process.stdout.write(text));
client.on('prompt', (p) => console.log(`Prompt: ${p}`));
client.on('emulated', (device) => console.log(`Mock: ${device}`));
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
| `with SSHClient(c) as client:` | `await using client = ...`         |

## Architecture

```
whirlwind-ssh/
├── src/
│   ├── index.ts        # Barrel exports
│   ├── client.ts       # WhirlwindSSHClient (main)
│   ├── types.ts        # Interfaces, config resolution
│   ├── filters.ts      # ANSI filtering, pagination constants
│   ├── legacy.ts       # Legacy/modern algorithm sets
│   ├── logger.ts       # Abstract logger (console default)
│   └── emulation.ts    # NetEmulate transparent redirect
├── package.json
└── tsconfig.json
```

### Key Design Decisions

**Event-driven buffering instead of synchronous recv:** Python's paramiko has `recv_ready()` and blocking `recv()`. Node's ssh2 is stream-based. The client maintains an internal `rxBuffer` fed by the channel's `data` event, with `waitForData()` returning a Promise that resolves when new data arrives. This gives the same command-and-collect pattern without blocking the event loop.

**Stale drain before every command:** Ported directly from the Python client. Without this, late-arriving bytes from the previous command cause `waitForPrompt()` to find the old prompt and return immediately — the infamous one-command-offset desync.

**Settle delay after prompt detection:** 50ms pause after finding the prompt, then one more buffer read. Catches trailing newlines and control characters that some devices send after the prompt. Prevents them from poisoning the next command's buffer.

**`keyboard-interactive` auto-response:** Many devices (especially behind Cisco ISE) force keyboard-interactive auth even when a password was provided. The handler auto-responds with the stored password.

## License

MIT
