/**
 * Whirlwind SSH Client — Legacy Algorithm Support
 * Ported from Python SCNG SSH Client (LegacySSHSupport class)
 *
 * Configure ssh2 for legacy device compatibility.
 * Legacy-first ordering: old ciphers/KEX listed first so they're
 * preferred during negotiation with ancient gear, but modern algos
 * are still present as fallback for newer devices.
 */

import type { Algorithms as SSH2Algorithms } from 'ssh2';

/**
 * Algorithm set for legacy device compatibility.
 *
 * Same ordering as Python client — legacy algorithms first,
 * modern fallbacks after. This ensures negotiation succeeds
 * with old IOS, JunOS, and EOS versions that only support
 * diffie-hellman-group1-sha1 or aes128-cbc.
 */
export const LEGACY_ALGORITHMS: SSH2Algorithms = {
  kex: [
    'diffie-hellman-group1-sha1',
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group-exchange-sha1',
    'diffie-hellman-group-exchange-sha256',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
  ] as any[],

  cipher: [
    'aes128-cbc',
    'aes256-cbc',
    '3des-cbc',
    'aes192-cbc',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
    'aes256-gcm@openssh.com',
    'aes128-gcm@openssh.com',
  ] as any[],

  serverHostKey: [
    'ssh-rsa',
    'ssh-dss',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'ssh-ed25519',
    'rsa-sha2-256',
    'rsa-sha2-512',
  ] as any[],

  hmac: [
    'hmac-sha1',
    'hmac-sha1-96',
    'hmac-md5',
    'hmac-md5-96',
    'hmac-sha2-256',
    'hmac-sha2-512',
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
  ] as any[],
};

/**
 * Modern-first algorithm set for current devices.
 * Used when legacyMode is false — secure defaults with
 * broad compatibility.
 */
/**
 * Modern-first algorithm set for current devices.
 * Used when legacyMode is false — prefers strong algorithms but
 * carries the full legacy set as tail fallback so no device is
 * left behind. Same superset as LEGACY_ALGORITHMS, different order.
 */
export const MODERN_ALGORITHMS: SSH2Algorithms = {
  kex: [
    // ── Modern preferred ──
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group14-sha256',
    // ── Legacy fallback ──
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group-exchange-sha1',
    'diffie-hellman-group1-sha1',
  ] as any[],

  cipher: [
    // ── Modern preferred ──
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes256-ctr',
    'aes192-ctr',
    'aes128-ctr',
    // ── Legacy fallback ──
    'aes256-cbc',
    'aes128-cbc',
    'aes192-cbc',
    '3des-cbc',
  ] as any[],

  serverHostKey: [
    // ── Modern preferred ──
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
    // ── Legacy fallback ──
    'ssh-rsa',
    'ssh-dss',
  ] as any[],

  hmac: [
    // ── Modern preferred ──
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
    // ── Legacy fallback ──
    'hmac-sha1',
    'hmac-sha1-96',
    'hmac-md5',
    'hmac-md5-96',
  ] as any[],
};

/**
 * Get the appropriate algorithm set for the connection mode.
 *
 * Always returns an explicit algorithm set — never undefined.
 * Returning undefined lets ssh2 use its built-in defaults, which
 * drop legacy algorithms entirely (no group1-sha1, no 3des-cbc,
 * no ssh-dss, no hmac-sha1). That breaks any device older than
 * ~2015 vintage IOS/JunOS/EOS.
 */
export function getAlgorithms(legacyMode: boolean): SSH2Algorithms {
  return legacyMode ? LEGACY_ALGORITHMS : MODERN_ALGORITHMS;
}