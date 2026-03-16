/**
 * Test 3: Full Pipeline — SSH → Command → Parse
 *
 * Connects to a real device, runs collection commands defined
 * in YAML, parses output with TextFSM/regex, and displays results.
 * This exercises the same path as the poll engine.
 *
 * Usage:
 *   npx tsc && node dist/tests/test-pipeline.js <host> <user> <pass> <vendor> [collection]
 *
 * Examples:
 *   node dist/tests/test-pipeline.js 10.0.0.1 admin admin arista_eos
 *   node dist/tests/test-pipeline.js 10.0.0.1 admin admin cisco_ios cpu
 *   node dist/tests/test-pipeline.js 10.0.0.1 admin admin arista_eos interfaces
 *
 * Vendors: cisco_ios, cisco_ios_xe, cisco_nxos, arista_eos, juniper_junos
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WhirlwindSSHClient, setLogger } from '../wirlwindssh';

// ─── Logger ──────────────────────────────────────────────────
setLogger({
  debug: () => {},  // Quiet for pipeline test
  info: (msg) => console.log(`  [INFO] ${msg}`),
  warn: (msg) => console.warn(`  [WARN] ${msg}`),
  error: (msg) => console.error(`  [ERR]  ${msg}`),
});

// ─── Parse CLI ───────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 4) {
  console.log('Usage: node dist/tests/test-pipeline.js <host> <user> <pass> <vendor> [collection]');
  console.log('');
  console.log('Vendors: cisco_ios, cisco_ios_xe, cisco_nxos, arista_eos, juniper_junos');
  console.log('Collections: cpu, memory, interfaces, interface_detail, neighbors, log');
  process.exit(1);
}

const [host, username, password, vendor] = args;
const filterCollection = args[4] ?? null;
const legacyMode = args.includes('--legacy');

// ─── Load collection YAMLs ───────────────────────────────────
function loadCollections(vendor: string): Record<string, any> {
  const collectionsDir = path.join(__dirname, '..', '..', 'collections');
  const result: Record<string, any> = {};

  if (!fs.existsSync(collectionsDir)) {
    console.error(`Collections dir not found: ${collectionsDir}`);
    return result;
  }

  const dirs = fs.readdirSync(collectionsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('_'));

  for (const dir of dirs) {
    const vendorFile = path.join(collectionsDir, dir.name, `${vendor}.yaml`);
    if (fs.existsSync(vendorFile)) {
      try {
        const def = yaml.load(fs.readFileSync(vendorFile, 'utf-8')) as any;
        result[dir.name] = def;
      } catch (e) {
        console.warn(`  Failed to load ${vendorFile}: ${e}`);
      }
    }
  }

  return result;
}

// ─── Regex parser ────────────────────────────────────────────
function parseRegex(output: string, patterns: any[]): Record<string, any> | null {
  const result: Record<string, any> = {};
  let matchCount = 0;

  for (const pat of patterns) {
    try {
      const match = output.match(new RegExp(pat.pattern, 'm'));
      if (match) {
        const group = pat.group ?? 1;
        let value: any = match[group] ?? match[0];
        if (pat.type === 'int') value = parseInt(value, 10);
        else if (pat.type === 'float') value = parseFloat(value);
        result[pat.name] = value;
        matchCount++;
      }
    } catch (e) {
      // Skip bad patterns
    }
  }

  return matchCount > 0 ? result : null;
}

// ─── TextFSM parser ─────────────────────────────────────────
function parseTextFSM(output: string, templateName: string): any[] | null {
  let TextFSMClass: any;
  try {
    const tfsmModule = require('../../src/tfsmjs/tfsm-node');
    TextFSMClass = tfsmModule.TextFSM;
  } catch {
    console.warn('  tfsmjs not available — skipping TextFSM');
    return null;
  }

  const templatesDir = path.join(__dirname, '..', '..', 'templates', 'textfsm');
  const candidates = [
    path.join(templatesDir, templateName),
    path.join(templatesDir, templateName + '.textfsm'),
  ];

  let templatePath: string | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { templatePath = p; break; }
  }

  if (!templatePath) {
    console.warn(`  Template not found: ${templateName}`);
    return null;
  }

  try {
    const content = fs.readFileSync(templatePath, 'utf-8');
    const fsm = new TextFSMClass(content);
    return fsm.parseTextToDicts(output);
  } catch (e: any) {
    console.warn(`  TextFSM parse error: ${e.message}`);
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' Wirlwind — Full Pipeline Test');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Host:       ${host}`);
  console.log(`  Vendor:     ${vendor}`);
  console.log(`  Collection: ${filterCollection ?? 'ALL'}`);
  console.log('');

  // Load collection definitions
  const collections = loadCollections(vendor);
  const collNames = Object.keys(collections);
  console.log(`  Loaded ${collNames.length} collections: ${collNames.join(', ')}`);

  if (collNames.length === 0) {
    console.error(`  No YAML files found for vendor: ${vendor}`);
    console.error(`  Check collections/*/${vendor}.yaml files exist`);
    process.exit(1);
  }
  console.log('');

  // Connect
  const client = new WhirlwindSSHClient({
    host, username, password, legacyMode,
  });

  try {
    console.log('┌─ Connecting...');
    await client.connect();
    const prompt = await client.findPrompt();
    client.setExpectPrompt(prompt);
    await client.disablePagination();
    console.log(`│  ✓ Connected — prompt: "${prompt}", hostname: ${client.hostname}`);
    console.log('');

    // Run each collection
    const toRun = filterCollection
      ? { [filterCollection]: collections[filterCollection] }
      : collections;

    for (const [name, def] of Object.entries(toRun)) {
      if (!def) {
        console.log(`┌─ [${name}] — no YAML definition for ${vendor}, skipping`);
        console.log('');
        continue;
      }

      console.log(`┌─ [${name}]`);
      console.log(`│  Command: ${def.command}`);
      console.log(`│  Parser:  ${def.parser}`);
      if (def.textfsm_template) console.log(`│  Template: ${def.textfsm_template}`);

      // Execute command
      const result = await client.executeCommand(def.command);
      console.log(`│  ✓ Output: ${result.output.length} chars, ${result.elapsed}ms, prompt: ${result.promptDetected}`);

      // Parse
      let parsed: any = null;

      if (def.parser === 'textfsm' && def.textfsm_template) {
        const rows = parseTextFSM(result.output, def.textfsm_template);
        if (rows && rows.length > 0) {
          parsed = { _parsed_by: 'textfsm', _template: def.textfsm_template, entries: rows };
          console.log(`│  ✓ TextFSM: ${rows.length} rows`);
          // Show first row keys
          if (rows[0] && typeof rows[0] === 'object') {
            console.log(`│  Keys: ${Object.keys(rows[0]).join(', ')}`);
          }
          // Preview first 2 rows
          rows.slice(0, 2).forEach((row: any, i: number) => {
            const preview = JSON.stringify(row).substring(0, 100);
            console.log(`│  [${i}] ${preview}${JSON.stringify(row).length > 100 ? '...' : ''}`);
          });
        } else {
          console.log(`│  ✗ TextFSM: no results`);
        }
      }

      if (!parsed && def.parser === 'regex' && def.regex_patterns) {
        parsed = parseRegex(result.output, def.regex_patterns);
        if (parsed) {
          console.log(`│  ✓ Regex: ${Object.keys(parsed).length} fields`);
          for (const [k, v] of Object.entries(parsed)) {
            console.log(`│    ${k}: ${v}`);
          }
        } else {
          console.log(`│  ✗ Regex: no matches`);
        }
      }

      if (!parsed) {
        console.log(`│  ✗ Parse failed — showing raw output (first 10 lines):`);
        result.output.split('\n').filter((l: string) => l.trim()).slice(0, 10).forEach((l: string) => {
          console.log(`│    ${l.substring(0, 100)}`);
        });
      }

      console.log('');
    }

    client.disconnect();
    console.log('═══════════════════════════════════════════════');
    console.log(' Pipeline test complete');
    console.log('═══════════════════════════════════════════════');

  } catch (err: any) {
    console.error(`✗ FAILED: ${err.message}`);
    client.disconnect();
    process.exit(1);
  }
}

main();