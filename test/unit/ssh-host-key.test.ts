import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { knownHostsVerdict, sha256Fingerprint } from '../../src/tunnels/ssh.provider';

const key = Buffer.from('this-is-a-fake-host-key-blob');
const keyB64 = key.toString('base64');
const otherKey = Buffer.from('a-different-key');

describe('sha256Fingerprint', () => {
  it('is the base64 sha256 of the key blob without padding', () => {
    const expected = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    expect(sha256Fingerprint(key)).toBe(expected);
    expect(sha256Fingerprint(key)).not.toMatch(/=$/);
  });
});

describe('knownHostsVerdict', () => {
  it('matches a plaintext host entry carrying the same key', () => {
    const content = `bastion.example.com ssh-ed25519 ${keyB64}\n`;
    expect(knownHostsVerdict(content, 'bastion.example.com', 22, key)).toBe('match');
  });

  it('uses the [host]:port form for non-standard ports', () => {
    const content = `[bastion.example.com]:2222 ssh-ed25519 ${keyB64}\n`;
    expect(knownHostsVerdict(content, 'bastion.example.com', 2222, key)).toBe('match');
    // the same host on the default port is not covered by that line
    expect(knownHostsVerdict(content, 'bastion.example.com', 22, key)).toBe('absent');
  });

  it('reports mismatch when the host is listed but the key differs', () => {
    const content = `bastion.example.com ssh-ed25519 ${otherKey.toString('base64')}\n`;
    expect(knownHostsVerdict(content, 'bastion.example.com', 22, key)).toBe('mismatch');
  });

  it('reports absent when no line references the host', () => {
    const content = `other.example.com ssh-ed25519 ${keyB64}\n`;
    expect(knownHostsVerdict(content, 'bastion.example.com', 22, key)).toBe('absent');
  });

  it('matches a hashed (|1|salt|hash) entry', () => {
    const salt = Buffer.from('0123456789abcdef0123'); // 20-byte HMAC-SHA1 salt
    const name = 'bastion.example.com';
    const hash = createHmac('sha1', salt).update(name).digest('base64');
    const content = `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${keyB64}\n`;
    expect(knownHostsVerdict(content, name, 22, key)).toBe('match');
  });

  it('treats a @revoked line with the matching key as a mismatch', () => {
    const content = `@revoked bastion.example.com ssh-ed25519 ${keyB64}\n`;
    expect(knownHostsVerdict(content, 'bastion.example.com', 22, key)).toBe('mismatch');
  });

  it('skips comments and blank lines', () => {
    const content = `# a comment\n\nbastion.example.com ssh-ed25519 ${keyB64}\n`;
    expect(knownHostsVerdict(content, 'bastion.example.com', 22, key)).toBe('match');
  });

  it('matches when the host is one of several comma-separated patterns', () => {
    const content = `alias.example.com,bastion.example.com ssh-rsa ${keyB64}\n`;
    expect(knownHostsVerdict(content, 'bastion.example.com', 22, key)).toBe('match');
  });
});
