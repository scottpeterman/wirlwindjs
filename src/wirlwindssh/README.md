# Wirlwind Telemetry

Real-time network device monitoring over SSH. Connect to a switch or router, poll it on a configurable interval, parse the output through TextFSM templates, and push live telemetry to an interactive dashboard — all from a single Electron app.

![Wirlwind Telemetry Dashboard](screenshots/slides.gif)

## What It Does

Wirlwind connects to a network device via SSH invoke-shell, runs CLI commands on a timed loop, structures the output through a TextFSM/regex parser chain, normalizes the results through vendor-specific drivers, and streams everything to an ECharts dashboard over Electron IPC.

One command to go from zero to live telemetry:

```bash
npm run dev -- --connect 172.17.1.128 cisco cisco123 arista_eos
```

The dashboard populates within the first poll cycle — CPU, memory, interface throughput, LLDP neighbors, interface status table, and device logs with syslog severity highlighting.

### Dashboard Panels

| Panel | Data Source | What It Shows |
|---|---|---|
| CPU Utilization | `show processes top once` | Gauge + 5-min average, top 20 process list |
| Memory Utilization | `show processes top once` | Gauge + used/total/free breakdown |
| Interface Throughput | `show interfaces` | Per-interface in/out bps chart, auto-scales bps → Kbps → Mbps → Gbps |
| LLDP/CDP Neighbors | `show lldp neighbors detail` | Topology graph with hostnames, management IPs, interface labels |
| Interface Description | `show interfaces description` | Status table with up/down/admin-down counts and descriptions |
| Device Log | `show logging last 24 hours` | Syslog entries color-coded by severity (emergency → debug) |
| Device Information | Connection metadata | Hostname, IP, vendor, connection status, last poll timestamp |

### Vendor Support

| Vendor | Driver | Live Tested | Notes |
|---|---|---|---|
| Arista EOS | `arista_eos` | ✅ Full dashboard | Linux `top` CPU format, LLDP neighbors |
| Cisco IOS | `cisco_ios` | — | `show processes cpu`, CDP/LLDP |
| Cisco IOS-XE | `cisco_ios_xe` | — | Shares Cisco IOS driver |
| Cisco NX-OS | `cisco_nxos` | — | Shares Cisco IOS driver |
| Juniper JunOS | `juniper_junos` | — | `show chassis routing-engine`, LLDP |

Adding a vendor: extend `BaseDriver`, override `postProcess`, call `registerDriver()`. The collection YAMLs and TextFSM templates handle the rest.

## Quick Start

```bash
# Install dependencies
npm install

# Connect to a device and start polling
npm run dev -- --connect <host> <user> <pass> <vendor>

# Examples
npm run dev -- --connect 10.0.0.1 admin secret arista_eos
npm run dev -- --connect 10.0.0.1 admin secret cisco_ios --legacy   # old ciphers
npm run dev -- --connect 10.0.0.1 admin secret juniper_junos --port 830

# Launch without auto-connect (demo mode)
npm run dev
```

### Build & Package

```bash
npm run build                    # TypeScript compile only
npm run build:linux              # AppImage + deb
npm run build:win                # NSIS installer
npm run build:mac                # DMG
```

### Tests

```bash
# Offline parser tests (32 tests — ANSI filter, regex, TextFSM, YAML loading)
npx tsc && node dist/tests/test-parse.js

# Live SSH test against a real device
npx tsc && node dist/tests/test-ssh.js <host> <user> <pass> [--debug]
```

## Architecture

Wirlwind is a monorepo with three interconnected subsystems:

| Subsystem | What | Where |
|---|---|---|
| **wirlwindssh** | SSH automation library (invoke-shell, prompt detection, pagination disable) | `src/wirlwindssh/` |
| **tfsmjs** | TextFSM parser for JavaScript (port of Google's Python TextFSM) | `src/tfsmjs/` |
| **wirlwind** | Electron app — poll engine, parser chain, drivers, dashboard | `src/wirlwind/` |

### Data Pipeline

Every poll cycle runs this pipeline for each collection:

```
Device CLI
    │
    ▼
executeCommand()          SSH invoke-shell, wait for prompt
    │
    ▼
scrubOutput()             Strip command echo (top) and prompt (bottom)
    │
    ▼
parseWithTrace()          TextFSM → regex → passthrough (priority chain)
    │
    ▼
shapeOutput()             entries[] → flat dict (cpu) or { interfaces: [] }
    │
    ▼
lowercaseKeys()           GLOBAL_CPU_PERCENT_IDLE → global_cpu_percent_idle
    │
    ▼
applyNormalize()          YAML field renames: neighbor_name → device_id
    │
    ▼
driver.postProcess()      Vendor-specific: parseRateToBps, normalizeCpu, etc.
    │
    ▼
stateStore.update()       In-memory state + ring buffers → IPC → dashboard
```

### Process Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer Process                                            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  index.html — ECharts dashboard                        │  │
│  │  Gauges, charts, topology graph, log viewer            │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       │ window.wirlwind (contextBridge)       │
│  ┌────────────────────┴───────────────────────────────────┐  │
│  │  preload.ts — IPC API                                  │  │
│  └────────────────────┬───────────────────────────────────┘  │
├───────────────────────┼──────────────────────────────────────┤
│  Main Process         │ ipcMain ↔ webContents                │
│  ┌────────────────────┴───────────────────────────────────┐  │
│  │  bridge.ts — TelemetryBridge                           │  │
│  └──┬─────────────────────────┬───────────────────────────┘  │
│     │                         │                               │
│  ┌──┴──────────────┐  ┌──────┴────────────────────────┐     │
│  │  stateStore.ts  │  │  pollEngine.ts                │     │
│  │  In-memory      │  │  scrubOutput → parse → shape  │     │
│  │  Ring buffers   │  │  → normalize → postProcess    │     │
│  └─────────────────┘  └──────┬──────────┬─────────────┘     │
│                              │          │                     │
│  ┌───────────────────────────┴┐  ┌─────┴──────────────────┐ │
│  │  parserChain.ts            │  │  drivers/              │ │
│  │  TextFSM → regex → pass   │  │  base.ts + logParsers  │ │
│  │  Uses tfsmjs               │  │  arista_eos.ts         │ │
│  └────────────────────────────┘  │  cisco_ios.ts          │ │
│                                  │  juniper_junos.ts      │ │
│  ┌────────────────────────────┐  └────────────────────────┘ │
│  │  collectionLoader.ts      │                               │
│  │  YAML → normalizedDef     │                               │
│  └────────────────────────────┘                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  wirlwindssh — WhirlwindSSHClient                      │  │
│  │  ssh2 invoke-shell, prompt detection, legacy ciphers   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Collection System

Collections define what to poll, how to parse, and how to normalize. Each collection is a YAML file per vendor stored in `collections/<name>/<vendor>.yaml`. The Python YAML format is auto-normalized to the TypeScript interface at load time — same files work in both projects.

```yaml
# collections/cpu/arista_eos.yaml
command: "show processes top once"
interval: 30

parsers:
  - type: textfsm
    templates:
      - arista_eos_show_processes_top_once.textfsm
  - type: regex
    pattern: '%Cpu\(s\):\s*(\S+)\s+us,\s*(\S+)\s+sy,\s*\S+\s+ni,\s*(\S+)\s+id'
    groups:
      user_pct: 1
      system_pct: 2
      idle_pct: 3

normalize:
  cpu_idle: global_cpu_percent_idle
  cpu_usr: global_cpu_percent_user
```

The parser chain tries each parser in priority order. If TextFSM fails, it falls back to regex. If regex fails, raw output passes through. The `normalize` map renames vendor-specific field names to the canonical names drivers and the dashboard expect.

### Built-in Collections

| Collection | Command (Arista) | Parser | Interval |
|---|---|---|---|
| `cpu` | `show processes top once` | TextFSM + regex | 30s |
| `memory` | `show processes top once` | TextFSM + regex | 30s |
| `interfaces` | `show interfaces description` | TextFSM | 60s |
| `interface_detail` | `show interfaces` | TextFSM | 60s |
| `neighbors` | `show lldp neighbors detail` | TextFSM | 300s |
| `bgp_summary` | `show ip bgp summary` | TextFSM | 120s |
| `log` | `show logging last 24 hours` | Driver (raw) | 30s |

## Workspace Overlay

When a vendor ships a new OS version that changes CLI output, you can override any template or collection without modifying the project.

```bash
# Create workspace
mkdir -p ~/.wirlwind/workspace/templates/textfsm
mkdir -p ~/.wirlwind/workspace/collections

# Override a broken template
cp templates/textfsm/arista_eos_show_interfaces.textfsm \
   ~/.wirlwind/workspace/templates/textfsm/
vi ~/.wirlwind/workspace/templates/textfsm/arista_eos_show_interfaces.textfsm

# Restart — workspace version loads instead of built-in
npm run dev -- --connect 172.17.1.128 cisco cisco123 arista_eos
```

Resolution order: **workspace first → built-in fallback**. Only include files you want to override.

The log confirms overrides:

```
Workspace (default): /home/user/.wirlwind/workspace
Workspace overrides: 1 templates, 0 collections
[workspace] template: arista_eos_show_interfaces.textfsm
```

Custom workspace path via `~/.wirlwind/config.json`:

```json
{ "workspace": "/home/user/my-wirlwind-workspace" }
```

## Driver System

Drivers handle vendor-specific post-processing. Each driver extends `BaseDriver` and overrides `postProcess()` to normalize fields into the canonical format the dashboard expects.

```
drivers/
├── base.ts              # BaseDriver, registry, shared transforms
├── logParsers.ts        # Vendor-specific syslog parsers
├── arista_eos.ts        # Arista EOS
├── cisco_ios.ts         # Cisco IOS/IOS-XE/NX-OS
└── juniper_junos.ts     # Juniper JunOS
```

### What Drivers Do

| Transform | Example |
|---|---|
| CPU normalization | Arista `idle_pct: 94` → `five_sec_total: 6` |
| Memory calculation | `total_kb` - `free_kb` → `used_pct: 60.6` |
| Rate conversion | `"23.5 kbps"` → `input_rate_bps: 23500` |
| Neighbor normalization | `neighbor_name` → `device_id`, FQDN stripping, platform extraction |
| Interface abbreviation | `Ethernet1` → `Et1`, `Port-Channel1` → `Po1` |
| Log parsing | Raw syslog → `{ timestamp, facility, severity, mnemonic, message }` |
| BGP state normalization | `state_pfx: "42"` → `state: "Established", prefixes_rcvd: 42` |

### Adding a Vendor

```typescript
// drivers/my_vendor.ts
import { BaseDriver, registerDriver } from './base';
import { parseGenericLog } from './logParsers';

export class MyVendorDriver extends BaseDriver {
  postConnectCommands = ['set cli screen-length 0'];

  postProcess(collection, data) {
    if (collection === 'cpu') {
      // vendor-specific CPU normalization
    }
    return data;
  }
}

registerDriver('my_vendor', MyVendorDriver);
```

Then import it in `drivers/index.ts`:

```typescript
import './my_vendor';
```

## Project Structure

```
wirlwind-js/
├── package.json
├── tsconfig.json
├── src/
│   ├── tfsmjs/
│   │   └── tfsm-node.js              # TextFSM parser (JS port)
│   ├── wirlwindssh/                   # SSH automation library (MIT)
│   │   ├── index.ts                   # Barrel exports
│   │   ├── client.ts                  # WhirlwindSSHClient
│   │   ├── types.ts                   # Config interfaces + defaults
│   │   ├── filters.ts                 # ANSI filter + pagination commands
│   │   ├── legacy.ts                  # Legacy/modern cipher sets
│   │   ├── logger.ts                  # Abstract logger
│   │   └── emulation.ts              # NetEmulate transparent redirect
│   ├── wirlwind/
│   │   ├── main/
│   │   │   ├── main.ts                # Electron entry + CLI arg parsing
│   │   │   ├── preload.ts             # contextBridge IPC API
│   │   │   ├── bridge.ts              # TelemetryBridge
│   │   │   ├── pollEngine.ts          # Poll loop + pipeline orchestration
│   │   │   ├── parserChain.ts         # TextFSM → regex → passthrough
│   │   │   ├── scrubOutput.ts         # Command echo + prompt stripping
│   │   │   ├── applyNormalize.ts      # YAML field rename maps
│   │   │   ├── stateStore.ts          # In-memory state + history rings
│   │   │   ├── collectionLoader.ts    # YAML loader + Python format normalizer
│   │   │   ├── workspace.ts           # Workspace overlay resolution
│   │   │   └── drivers/
│   │   │       ├── index.ts           # Barrel + registration side-effects
│   │   │       ├── base.ts            # BaseDriver, registry, shared transforms
│   │   │       ├── logParsers.ts      # Vendor-specific syslog parsers
│   │   │       ├── arista_eos.ts      # Arista EOS driver
│   │   │       ├── cisco_ios.ts       # Cisco IOS/IOS-XE/NX-OS driver
│   │   │       └── juniper_junos.ts   # Juniper JunOS driver
│   │   ├── renderer/
│   │   │   └── index.html             # ECharts dashboard
│   │   └── shared/
│   │       └── types.ts               # Shared types, IPC channels
│   └── tests/
│       ├── test-parse.ts              # Offline: 32 parser tests
│       ├── test-ssh.ts                # Live: SSH connect/command
│       └── test-pipeline.ts           # Live: full pipeline test
├── collections/                       # 7 collections × 4 vendors (YAML)
├── templates/textfsm/                 # 14 TextFSM templates
└── tools/
    └── tfsm-tester.html               # Standalone TextFSM template tester
```

## IPC Protocol

**Renderer → Main** (invoke/handle):

| Channel | Payload | Returns |
|---|---|---|
| `wt:connect` | `DeviceTarget` | `{ success, error? }` |
| `wt:disconnect` | — | `{ success }` |
| `wt:start-polling` / `wt:stop-polling` | — | `{ success }` |
| `wt:get-snapshot` | — | `TelemetryState` |
| `wt:get-history` | `'cpu' \| 'memory'` | `HistoryEntry[]` |

**Main → Renderer** (send/on):

| Channel | Payload |
|---|---|
| `wt:state-changed` | `{ collection, data }` |
| `wt:cycle-complete` | `{ cycle, elapsed }` |
| `wt:connection-status` | `'connected' \| 'disconnected' \| 'error'` |
| `wt:device-info` | `DeviceInfo` |

## Tools

### tfsm-tester

Standalone browser-based TextFSM template tester. Paste a template and device output, hit Parse, see results as a table or JSON. The full tfsmjs engine is embedded — no dependencies, no server, just open the HTML file.

Located at `tools/tfsm-tester.html`.

## Python Lineage

This is a TypeScript port of the PyQt6-based Wirlwind Telemetry. The data flow, collection format, TextFSM templates, and dashboard layout are carried over directly.

| Python | TypeScript |
|---|---|
| paramiko invoke-shell | ssh2 invoke-shell (wirlwindssh) |
| QWebChannel + QObject signals | contextBridge + ipcMain/ipcRenderer |
| TextFSM (ntc-templates) | tfsmjs (tfsm-node.js) |
| PyQt6 QWebEngineView | Electron BrowserWindow |
| `yaml.safe_load` | js-yaml + `normalizeCollectionDef()` |
| `state_store.py` (dict + signals) | `stateStore.ts` (EventEmitter) |
| `poll_engine.py` | `pollEngine.ts` (async/await) |
| `parser_chain.py` | `parserChain.ts` |
| `bridge.py` (slots/signals) | `bridge.ts` (IPC handle/send) |
| `drivers/__init__.py` | `drivers/base.ts` |
| `drivers/arista_eos.py` | `drivers/arista_eos.ts` |

## Version Alignment

Versions are pinned to match the nterm-js project for shared Electron/ssh2 compatibility:

```
electron:          ^33.0.0
ssh2:              ^1.16.0
electron-log:      ^5.0.0
better-sqlite3:    ^12.8.0
js-yaml:           ^4.1.0
typescript:        ^5.4.0
electron-builder:  ^25.0.0
```

## License

GPL-3.0 (Electron app). The wirlwindssh SSH library is MIT licensed separately.