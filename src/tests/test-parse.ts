/**
 * Test 2: Parser Chain
 *
 * Tests TextFSM (tfsmjs) and regex parsing against sample command output.
 * Does NOT require SSH or Electron — pure Node.js.
 *
 * Usage:
 *   npx tsc && node dist/tests/test-parse.js
 *
 * Tests:
 *   1. tfsmjs loads and parses a template
 *   2. Regex patterns extract values
 *   3. ANSI filter strips escape sequences
 */

import * as fs from 'fs';
import * as path from 'path';
import { filterAnsiSequences } from '../wirlwindssh/filters';

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ─── Test: ANSI Filter ───────────────────────────────────────
function testAnsiFilter() {
  console.log('');
  console.log('┌─ ANSI Filter');

  const dirty = '\x1b[32mhostname\x1b[0m#\x07 show version\r\n';
  const clean = filterAnsiSequences(dirty);

  ok('Strips CSI color codes', !clean.includes('\x1b['));
  ok('Strips bell character', !clean.includes('\x07'));
  ok('Preserves text content', clean.includes('hostname'));
  ok('Preserves prompt chars', clean.includes('#'));

  const empty = filterAnsiSequences('');
  ok('Handles empty string', empty === '');

  const noAnsi = filterAnsiSequences('clean text here');
  ok('Passes clean text through', noAnsi === 'clean text here');
}

// ─── Test: Regex Parsing ─────────────────────────────────────
function testRegexParsing() {
  console.log('');
  console.log('┌─ Regex Parsing (Cisco IOS CPU)');

  // Sample "show processes cpu" output
  const sampleOutput = `
CPU utilization for five seconds: 23%/2%; one minute: 18%; five minutes: 15%
 PID Runtime(ms)     Invoked      uSecs   5Sec   1Min   5Min TTY Process
   1          12        1234         10  0.00%  0.00%  0.00%   0 Chunk Manager
   2       45678       56789        803  1.23%  0.98%  0.87%   0 IOSD ipc task
`;

  // Same patterns from collections/cpu/cisco_ios.yaml
  const patterns = [
    { name: 'five_sec_total', pattern: 'CPU utilization for five seconds:\\s+(\\d+)%', type: 'float' },
    { name: 'one_min', pattern: 'one minute:\\s+(\\d+)%', type: 'float' },
    { name: 'five_min', pattern: 'five minutes:\\s+(\\d+)%', type: 'float' },
  ];

  const result: Record<string, any> = {};
  for (const pat of patterns) {
    const match = sampleOutput.match(new RegExp(pat.pattern, 'm'));
    if (match) {
      result[pat.name] = pat.type === 'float' ? parseFloat(match[1]) : match[1];
    }
  }

  ok('Extracts five_sec_total', result.five_sec_total === 23);
  ok('Extracts one_min', result.one_min === 18);
  ok('Extracts five_min', result.five_min === 15);

  console.log('');
  console.log('┌─ Regex Parsing (Arista EOS Memory — top output)');

  const aristaTopOutput = `
top - 14:23:45 up 127 days,  3:42,  1 user,  load average: 0.08, 0.03, 0.01
Tasks: 142 total,   1 running, 141 sleeping,   0 stopped,   0 zombie
%Cpu(s):  1.2 us,  0.8 sy,  0.0 ni, 97.8 id,  0.2 wa,  0.0 hi,  0.0 si,  0.0 st
KiB Mem :  8052056 total,  1234567 free,  3456789 used,  3360700 buff/cache
`;

  const memPatterns = [
    { name: 'total_kb', pattern: 'KiB Mem\\s*:\\s*(\\d+)\\s+total', type: 'float' },
    { name: 'free_kb', pattern: '(\\d+)\\s+free', type: 'float' },
    { name: 'used_kb', pattern: '(\\d+)\\s+used', type: 'float' },
  ];

  const memResult: Record<string, any> = {};
  for (const pat of memPatterns) {
    const match = aristaTopOutput.match(new RegExp(pat.pattern, 'm'));
    if (match) {
      memResult[pat.name] = parseFloat(match[1]);
    }
  }

  ok('Extracts total_kb', memResult.total_kb === 8052056);
  ok('Extracts free_kb', memResult.free_kb === 1234567);
  ok('Extracts used_kb', memResult.used_kb === 3456789);

  // Test the Arista CPU idle → used conversion (from arista_eos.py)
  console.log('');
  console.log('┌─ Arista CPU Idle → Used Conversion');

  const cpuIdleMatch = aristaTopOutput.match(/([\d.]+)\s+id/);
  const idle = cpuIdleMatch ? parseFloat(cpuIdleMatch[1]) : null;
  const cpuUsed = idle !== null ? Math.round((100 - idle) * 10) / 10 : null;

  ok('Extracts idle %', idle === 97.8);
  ok('Computes used % (100 - idle)', cpuUsed === 2.2);
}

// ─── Test: TextFSM (tfsmjs) ─────────────────────────────────
function testTextFSM() {
  console.log('');
  console.log('┌─ TextFSM (tfsmjs)');

  let TextFSMClass: any;
  try {
    const tfsmModule = require('../../src/tfsmjs/tfsm-node');
    TextFSMClass = tfsmModule.TextFSM;
    ok('tfsmjs module loads', !!TextFSMClass);
  } catch (e: any) {
    ok('tfsmjs module loads', false, e.message);
    console.log('  │ Skipping TextFSM tests — module not available');
    return;
  }

  // Check templates directory exists
  const templatesDir = path.join(__dirname, '..', '..', 'templates', 'textfsm');
  const templateExists = fs.existsSync(templatesDir);
  ok('templates/textfsm/ directory exists', templateExists);

  if (!templateExists) return;

  const templates = fs.readdirSync(templatesDir).filter(f => f.endsWith('.textfsm'));
  ok(`Found ${templates.length} TextFSM templates`, templates.length > 0);

  // Try loading and compiling each template (no parse, just validate)
  let loadErrors = 0;
  for (const tmpl of templates) {
    try {
      const content = fs.readFileSync(path.join(templatesDir, tmpl), 'utf-8');
      new TextFSMClass(content);
    } catch (e: any) {
      console.log(`  ✗ Template load failed: ${tmpl} — ${e.message}`);
      loadErrors++;
    }
  }
  ok(`All templates compile (${templates.length - loadErrors}/${templates.length})`, loadErrors === 0);

  // Test actual parse with the Arista show processes top once template
  const aristaTopTemplate = path.join(templatesDir, 'arista_eos_show_processes_top_once.textfsm');
  if (fs.existsSync(aristaTopTemplate)) {
    console.log('');
    console.log('┌─ TextFSM Parse: arista_eos_show_processes_top_once');

    const sampleTop = `top - 14:23:45 up 127 days,  3:42,  1 user,  load average: 0.08, 0.03, 0.01
Tasks: 142 total,   1 running, 141 sleeping,   0 stopped,   0 zombie
%Cpu(s):  1.2 us,  0.8 sy,  0.0 ni, 97.8 id,  0.2 wa,  0.0 hi,  0.0 si,  0.0 st
KiB Mem :  8052056 total,  1234567 free,  3456789 used,  3360700 buff/cache
KiB Swap:  0 total,  0 free,  0 used.  4321098 avail Mem

  PID USER      PR  NI    VIRT    RES    SHR S  %CPU %MEM     TIME+ COMMAND
    1 root      20   0  168284  10284   7716 S   0.0  0.1   2:34.56 systemd
  123 root      20   0 1234568 234567 123456 S   1.2  2.9  45:12.34 Sysdb
  456 root      20   0  567890  89012  45678 S   0.8  1.1  12:34.56 Rib
`;

    try {
      const content = fs.readFileSync(aristaTopTemplate, 'utf-8');
      const fsm = new TextFSMClass(content);
      const results = fsm.parseTextToDicts(sampleTop);

      ok('TextFSM returns results', results && results.length > 0,
        results ? `${results.length} rows` : 'null');

      if (results && results.length > 0) {
        const first = results[0];
        const keys = Object.keys(first);
        ok('Results have keys', keys.length > 0, keys.join(', '));
      }
    } catch (e: any) {
      ok('TextFSM parse succeeds', false, e.message);
    }
  }
}

// ─── Test: Rate String Parser (from arista_eos.py) ───────────
function testRateParser() {
  console.log('');
  console.log('┌─ Rate String → bps Conversion (Arista driver logic)');

  // Port of _parse_rate_to_bps from arista_eos.py
  const RATE_PATTERN = /([\d.]+)\s*(bps|[Kk]bps|[Mm]bps|[Gg]bps)/i;
  const RATE_MULTIPLIERS: Record<string, number> = {
    'bps': 1,
    'kbps': 1000,
    'mbps': 1000000,
    'gbps': 1000000000,
  };

  function parseRateToBps(rateStr: any): number {
    if (rateStr === null || rateStr === undefined || rateStr === '') return 0;
    const s = String(rateStr).trim();

    // Try bare integer
    const asInt = parseInt(s, 10);
    if (!isNaN(asInt) && String(asInt) === s) return asInt;

    // Try float
    const asFloat = parseFloat(s);
    if (!isNaN(asFloat) && String(asFloat) === s) return Math.floor(asFloat);

    // Try rate with units
    const m = s.match(RATE_PATTERN);
    if (m) {
      const value = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      return Math.floor(value * (RATE_MULTIPLIERS[unit] ?? 1));
    }
    return 0;
  }

  ok('"0 bps" → 0', parseRateToBps('0 bps') === 0);
  ok('"1234 bps" → 1234', parseRateToBps('1234 bps') === 1234);
  ok('"1.23 Kbps" → 1230', parseRateToBps('1.23 Kbps') === 1230);
  ok('"5.67 Mbps" → 5670000', parseRateToBps('5.67 Mbps') === 5670000);
  ok('"1.2 Gbps" → 1200000000', parseRateToBps('1.2 Gbps') === 1200000000);
  ok('bare int "4567" → 4567', parseRateToBps('4567') === 4567);
  ok('null → 0', parseRateToBps(null) === 0);
  ok('empty string → 0', parseRateToBps('') === 0);
}

// ─── Test: Collection YAML Loading ───────────────────────────
function testCollections() {
  console.log('');
  console.log('┌─ Collection YAML Files');

  const collectionsDir = path.join(__dirname, '..', '..', 'collections');
  const collExists = fs.existsSync(collectionsDir);
  ok('collections/ directory exists', collExists);
  if (!collExists) return;

  const collections = fs.readdirSync(collectionsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map(e => e.name);

  ok(`Found ${collections.length} collections`, collections.length > 0, collections.join(', '));

  // Check each collection has at least a _schema.yaml
  let schemaCount = 0;
  let vendorCount = 0;
  for (const coll of collections) {
    const schemaPath = path.join(collectionsDir, coll, '_schema.yaml');
    if (fs.existsSync(schemaPath)) schemaCount++;

    const yamlFiles = fs.readdirSync(path.join(collectionsDir, coll))
      .filter(f => f.endsWith('.yaml') && !f.startsWith('_'));
    vendorCount += yamlFiles.length;
  }

  ok(`Schemas present (${schemaCount}/${collections.length})`, schemaCount === collections.length);
  ok(`Vendor YAML files: ${vendorCount}`, vendorCount > 0);
}

// ─── Run All ─────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════');
console.log(' Wirlwind — Parser & Collection Tests');
console.log('═══════════════════════════════════════════════');

testAnsiFilter();
testRegexParsing();
testRateParser();
testTextFSM();
testCollections();

console.log('');
console.log('═══════════════════════════════════════════════');
console.log(` Results: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════');

process.exit(failed > 0 ? 1 : 0);