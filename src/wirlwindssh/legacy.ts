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
    'chacha20-poly1305@openssh.com',
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
};

/**
 * Modern-first algorithm set for current devices.
 * Used when legacyMode is false — secure defaults with
 * broad compatibility.
 */
export const MODERN_ALGORITHMS: SSH2Algorithms = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group14-sha1',
  ] as any[],

  cipher: [
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'chacha20-poly1305@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
  ] as any[],

  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
  ] as any[],
};

/**
 * Get the appropriate algorithm set for the connection mode.
 */
export function getAlgorithms(legacyMode: boolean): SSH2Algorithms | undefined {
  return legacyMode ? LEGACY_ALGORITHMS : undefined;
}