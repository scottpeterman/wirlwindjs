# Wirlwind-JS — Port Status & Next Steps

**Date:** 2025-03-15 (updated 2026-03-15)
**Project:** Electron/TypeScript port of Wirlwind Telemetry (PyQt6 → Electron)

---

## What Was Built

### Three Interconnected Components

| Component | Source | Port | Status |
|---|---|---|---|
| **wirlwindssh** | `scng/discovery/ssh/client.py` (paramiko) | `src/wirlwindssh/` (ssh2) | ✅ Event-driven prompt detection, live-tested |
| **wirlwind telemetry** | `wirlwind_telemetry/` (PyQt6 + QWebChannel) | `src/wirlwind/` (Electron + IPC) | ✅ Full pipeline live — SSH → parse → driver → dashboard |
| **tfsmjs** | `scottpeterman/tfsmjs` | `src/tfsmjs/tfsm-node.js` | ✅ All 13 templates compile and parse |

---

## Test Results

### test-parse (32/32 ✅)

All offline tests pass: ANSI filter, regex parsing, rate string conversion, TextFSM template compilation, collection YAML loading.

### test-ssh (✅ fully working)

Connected to Arista vEOS device (`agg1.iad1`, 172.17.1.128):

- ✅ SSH connect (ssh2 + keyboard-interactive): 2,389ms
- ✅ Prompt detection (`agg1.iad1>`): 383ms
- ✅ Pagination shotgun: 615ms
- ✅ `show version`: 499 chars, prompt detected, 1,066ms
- ✅ `show clock`: 84 chars, prompt detected, 1,273ms

### Live Dashboard (✅ data flowing end-to-end)

Full pipeline validated against Arista vEOS via CLI auto-connect:

```bash
npm run dev -- --connect 172.17.1.128 cisco cisco123 arista_eos
```

- ✅ 7 collections loaded from Python YAML format (auto-normalized)
- ✅ CPU gauge: 6% (TextFSM `show processes top once` → driver `normalizeCpu`)
- ✅ Memory gauge: 60.6% (TextFSM → driver `normalizeMemory`)
- ✅ LLDP neighbors: 7 peers detected (TextFSM → driver `postProcessNeighbors`)
- ✅ Interface throughput: chart recording per-interface rates
- ✅ Interface detail: TextFSM parsing, per-interface dropdown
- ✅ Device info panel: hostname, IP, vendor populated on connect
- ✅ 30-second poll cycles running continuously
- ✅ Dark/light theme toggle, zoom controls, debug JSON modal all functional

---

## Bugs Fixed (March 2026 Session)

### 1. SSH Client — Event Loop Starvation

**Root cause:** `waitForData()` had an early return when `rxBuffer.length > 0`. The buffer always contained the command echo, so the polling loop never yielded to the I/O event queue. ssh2 data callbacks never fired.

**Fix:** Rewrote `waitForPrompt` as event-driven — registers a `promptChecker` callback on the ssh2 data handler. Prompt checked on every incoming chunk with zero-latency wakeup. Removed stale-buffer early return from `waitForData`. `findPrompt` now polls at 50ms intervals instead of sleeping full `shellTimeout`.

**Result:** Prompt detection 15s → 383ms. Pagination disable 15s → 615ms.

### 2. Electron OpenSSL Algorithm Mismatch

**Root cause:** Electron bundles its own OpenSSL which doesn't support `chacha20-poly1305@openssh.com`. The `MODERN_ALGORITHMS` set included it, causing connection failures in Electron while system Node.js worked fine.

**Fix:** `getAlgorithms()` returns `undefined` when `legacyMode` is false, letting ssh2 use its own defaults that are self-consistent with the bundled crypto backend.

### 3. CSS `:root` Premature Close

**Root cause:** The closing `}` for `:root` was placed after `--font-data`, orphaning `--chart-line-thin`, `--gauge-ok-stop`, `--glow-opacity`, and `--scanline-display` outside any selector.

**Fix:** Moved `}` to after `--scanline-display: none;`.

### 4. Python YAML Collection Format Incompatibility

**Root cause:** Python YAMLs use `parsers:` (array with priority chain) but the TS `CollectionDef` expected `parser:` (singular string) + flat fields. The YAML loaded fine but the parser chain found nothing to do.

**Fix:** Added `normalizeCollectionDef()` in `collectionLoader.ts` that converts the Python `parsers[]` array format to the TS flat interface. Same YAML files work in both projects with zero migration.

### 5. TextFSM Field Case Mismatch

**Root cause:** Python's TextFSM lowercases all field names. tfsmjs preserves the template's uppercase (`GLOBAL_CPU_PERCENT_IDLE`). Drivers expected lowercase (`global_cpu_percent_idle`).

**Fix:** Added `lowercaseKeys()` in `pollEngine.ts` that recursively lowercases all keys after the shape step, before drivers see the data.

### 6. Missing `shapeOutput` Step in Poll Pipeline

**Root cause:** TextFSM returned `{ entries: [{...}, {...}] }` but drivers expected shaped data — flat dict for CPU/memory, `{ interfaces: [...] }` for multi-row collections. The shape step between parse and postProcess was missing.

**Fix:** Added `shapeOutput` call in `pollEngine.runCycle()` using `defaultShapeOutput` from the driver base. Single-row collections flatten `entries[0]` to top level with `entries[1:]` as `processes`. Multi-row collections wrap entries in the expected key.

---

## Architecture Completed This Session

### Full Driver Architecture (ported from Python)

Replaced the single stub `drivers/index.ts` with a proper multi-file driver system:

```
src/wirlwind/main/drivers/
├── index.ts          # Barrel exports + side-effect imports for registration
├── base.ts           # BaseDriver, registry, shared transforms
├── arista_eos.ts     # Full Arista EOS driver
├── juniper_junos.ts  # Full Juniper JunOS driver
└── cisco_ios.ts      # Cisco IOS/IOS-XE/NX-OS driver
```

5 vendor IDs registered: `cisco_ios`, `cisco_ios_xe`, `cisco_nxos`, `arista_eos`, `juniper_junos`.

Shared transforms ported from Python `__init__.py`: `defaultShapeOutput`, `computeMemoryPct`, `postProcessLog` (with raw-text fallback), `normalizeBgpPeers`, `filterCpuProcesses`, `mergeMemoryIntoProcesses`, `parseRateToBps`.

### CLI Auto-Connect

```bash
npm run dev -- --connect <host> <user> <pass> <vendor> [--legacy] [--port N]
```

Parses CLI args in `main.ts`, calls `bridge.connectToDevice()` after renderer loads. Reusable for automation and testing.

### Dashboard Additions

- **Device Information panel** — third column in top row alongside CPU and Memory gauges
- **CPU and Memory gauges** — unhidden, now visible in first row
- **CSS `:root` brace fix** — all CSS custom properties now properly scoped

---

## Known Issues (Remaining)

### 1. Normalize Map Not Applied (Priority: HIGH)

The `normalize` field from collection YAMLs is stored in `CollectionDef` but never applied in the pipeline. This means:
- Neighbors show as "neighbor-0" instead of hostnames (field is `neighbor_name`, driver expects `device_id`)
- Interface rate fields aren't renamed to `input_rate_bps`/`output_rate_bps`
- CPU field aliases from YAML aren't applied

**Fix needed:** Add a normalize step in `pollEngine.runCycle()` between lowercaseKeys and postProcess that applies `def.normalize` as a field rename map.

### 2. Missing TextFSM Template (Priority: LOW)

`arista_eos_show_interfaces_description.textfsm` is not in `templates/textfsm/`. The `interfaces` collection fails.

### 3. Log Regex Patterns Failing (Priority: LOW)

The Arista log collection uses `parser: regex` with 5 patterns but they fail against actual vEOS output.

### 4. Connection UI (Priority: MEDIUM)

Dashboard requires `--connect` CLI args. No renderer-side connect dialog yet. The IPC handler exists — just needs a UI form.

---

## Next Steps

### Phase 1: Normalize Map

Apply `def.normalize` as field renames in the poll pipeline. Unblocks neighbor names, interface rate fields, and CPU field aliases.

### Phase 2: Template & Collection Cleanup

1. Copy `arista_eos_show_interfaces_description.textfsm` from ntc-templates
2. Fix Arista log regex patterns for vEOS format
3. Validate interface throughput rates are non-zero after normalize map

### Phase 3: Connection UI

Add a connect dialog to `index.html`. Store last-used connection in localStorage.

### Phase 4: Polish & Package

- Credential management (nterm-js vault integration)
- Package with electron-builder
- History trend chart (hidden panel, ready to unhide)

---

## Key Decisions Made

| Decision | Rationale |
|---|---|
| Monorepo (not npm packages) | Simpler for development, matches nterm-js structure |
| Event-driven `waitForPrompt`, not polling | Fixed event loop starvation; zero-latency prompt detection |
| `getAlgorithms` returns `undefined` in modern mode | Electron OpenSSL doesn't support all algorithms; let ssh2 pick its own |
| Python YAML format auto-normalized | Same collection files work in both projects; zero migration |
| `lowercaseKeys` after shape | tfsmjs preserves case; Python lowercases; normalize once centrally |
| `shapeOutput` between parse and postProcess | TextFSM returns entries[]; drivers expect flat dicts or wrapped lists |
| CLI `--connect` args | Faster iteration than connection UI; reusable for automation |
| Dashboard HTML in `src/`, not `dist/` | Static asset, no compilation needed; `extraResources` copies for packaging |

---

## Version Alignment (with nterm-js)

```
electron:        ^33.0.0
ssh2:            ^1.16.0
electron-log:    ^5.0.0
better-sqlite3:  ^12.8.0
js-yaml:         ^4.1.0
typescript:      ^5.4.0
electron-builder: ^25.0.0
```