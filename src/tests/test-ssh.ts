/**
 * Test 1: SSH Connection + Prompt + Command
 *
 * Verifies the whirlwindssh stack works end-to-end:
 *   connect → find prompt → disable pagination → execute command → disconnect
 *
 * Usage:
 *   npx tsc && node dist/tests/test-ssh.js <host> <username> <password> [--legacy]
 *
 * Example:
 *   node dist/tests/test-ssh.js 192.168.1.1 admin admin
 *   node dist/tests/test-ssh.js 10.0.0.1 admin admin --legacy
 */

import { WhirlwindSSHClient, setLogger } from '../wirlwindssh';

// ─── Simple console logger with timestamps ───────────────────
setLogger({
  debug: (msg) => console.log(`  [DEBUG] ${msg}`),
  info: (msg) => console.log(`  [INFO]  ${msg}`),
  warn: (msg) => console.warn(`  [WARN]  ${msg}`),
  error: (msg) => console.error(`  [ERROR] ${msg}`),
});

// ─── Parse CLI args ──────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('Usage: node dist/tests/test-ssh.js <host> <username> <password> [--legacy]');
  console.log('');
  console.log('Options:');
  console.log('  --legacy    Enable legacy cipher/KEX support');
  console.log('  --debug     Show full output buffers');
  process.exit(1);
}

const host = args[0];
const username = args[1];
const password = args[2];
const legacyMode = args.includes('--legacy');
const debug = args.includes('--debug');

// ─── Test commands per vendor (auto-detect from prompt) ──────
const TEST_COMMANDS = [
  'show version',
  'show clock',
];

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log(' Wirlwind SSH — Connection Test');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Host:     ${host}`);
  console.log(`  User:     ${username}`);
  console.log(`  Legacy:   ${legacyMode}`);
  console.log('');

  const client = new WhirlwindSSHClient({
    host,
    username,
    password,
    legacyMode,
  });

  try {
    // ── Step 1: Connect ──────────────────────────────────
    console.log('┌─ Step 1: Connect');
    const connectStart = Date.now();
    await client.connect();
    console.log(`│  ✓ Connected in ${Date.now() - connectStart}ms`);
    console.log(`│  Emulated: ${client.isEmulated}`);
    console.log('');

    // ── Step 2: Detect prompt ────────────────────────────
    console.log('┌─ Step 2: Detect Prompt');
    const promptStart = Date.now();
    const prompt = await client.findPrompt();
    console.log(`│  ✓ Prompt detected in ${Date.now() - promptStart}ms`);
    console.log(`│  Prompt:   "${prompt}"`);
    console.log(`│  Hostname: ${client.hostname ?? '(could not extract)'}`);
    client.setExpectPrompt(prompt);
    console.log('');

    // ── Step 3: Disable pagination ───────────────────────
    console.log('┌─ Step 3: Disable Pagination');
    const pagStart = Date.now();
    await client.disablePagination();
    console.log(`│  ✓ Pagination disabled in ${Date.now() - pagStart}ms`);
    console.log('');

    // ── Step 4: Execute commands ─────────────────────────
    for (const cmd of TEST_COMMANDS) {
      console.log(`┌─ Step 4: Execute "${cmd}"`);
      const result = await client.executeCommand(cmd);
      console.log(`│  ✓ Completed in ${result.elapsed}ms`);
      console.log(`│  Prompt detected: ${result.promptDetected}`);
      console.log(`│  Output length: ${result.output.length} chars`);

      if (debug) {
        console.log('│  ┌─ Output ─────────────────────────────');
        const lines = result.output.split('\n').slice(0, 30);
        for (const line of lines) {
          console.log(`│  │ ${line}`);
        }
        if (result.output.split('\n').length > 30) {
          console.log(`│  │ ... (${result.output.split('\n').length - 30} more lines)`);
        }
        console.log('│  └────────────────────────────────────');
      } else {
        // Show first 3 lines as preview
        const preview = result.output.split('\n').filter(l => l.trim()).slice(0, 3);
        for (const line of preview) {
          console.log(`│  │ ${line.substring(0, 80)}`);
        }
      }
      console.log('');
    }

    // ── Step 5: Disconnect ───────────────────────────────
    console.log('┌─ Step 5: Disconnect');
    client.disconnect();
    console.log('│  ✓ Disconnected');
    console.log('');

    console.log('═══════════════════════════════════════════════');
    console.log(' ALL TESTS PASSED');
    console.log('═══════════════════════════════════════════════');

  } catch (err: any) {
    console.error('');
    console.error(`✗ FAILED: ${err.message}`);
    console.error('');
    if (err.message.includes('authentication') || err.message.includes('auth')) {
      console.error('  Hint: Check username/password');
    }
    if (err.message.includes('ECONNREFUSED') || err.message.includes('connect')) {
      console.error('  Hint: Check host is reachable and SSH is running');
    }
    if (err.message.includes('handshake') || err.message.includes('kex')) {
      console.error('  Hint: Try --legacy flag for older devices');
    }
    client.disconnect();
    process.exit(1);
  }
}

main();