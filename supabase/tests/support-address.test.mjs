// The address behind a support report (rate limit only): which header is believed, and the hash.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { clientAddress, keyedHash } from '../functions/support/address.js';

const headers = (o) => new Headers(o);

test('support: only the address the platform sets is believed, never x-forwarded-for', () => {
  assert.equal(clientAddress(headers({ 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(clientAddress(headers({ 'cf-connecting-ip': '2001:db8::1' })), '2001:db8::1');
  // What the caller writes themselves counts for nothing.
  assert.equal(clientAddress(headers({ 'x-forwarded-for': '198.51.100.9' })), null);
  assert.equal(clientAddress(headers({ 'x-real-ip': '198.51.100.9' })), null);
  assert.equal(clientAddress(headers({ 'x-forwarded-for': '198.51.100.9', 'cf-connecting-ip': '203.0.113.7' })), '203.0.113.7');
  // No header, or one that is no address: no address.
  assert.equal(clientAddress(headers({})), null);
  assert.equal(clientAddress(headers({ 'cf-connecting-ip': '' })), null);
  assert.equal(clientAddress(headers({ 'cf-connecting-ip': 'not an address; drop table' })), null);
  assert.equal(clientAddress(headers({ 'cf-connecting-ip': '1'.repeat(60) })), null);
});

test('support: the address is hashed with its own secret, or not at all', async () => {
  const secret = 'a-long-random-secret-for-the-hash';
  const a = await keyedHash('203.0.113.7', secret);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await keyedHash('203.0.113.7', secret), 'the same address always gives the same hash');
  assert.notEqual(a, await keyedHash('203.0.113.8', secret));
  assert.notEqual(a, await keyedHash('203.0.113.7', 'another-long-random-secret-here'), 'the secret matters');
  // No (or a short) secret: no hash, so no address limit, rather than one anybody could redo.
  assert.equal(await keyedHash('203.0.113.7', ''), null);
  assert.equal(await keyedHash('203.0.113.7', undefined), null);
  assert.equal(await keyedHash('203.0.113.7', 'short'), null);
  assert.equal(await keyedHash(null, secret), null);
});

test('support: the function no longer trusts x-forwarded-for or hashes with the service key', () => {
  const code = readFileSync(new URL('../functions/support/index.ts', import.meta.url), 'utf8');
  const live = code.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(live, /x-forwarded-for/i);
  assert.match(live, /SUPPORT_IP_HASH_KEY/);
  assert.match(live, /keyedHash\(ip, IP_HASH_KEY\)/);
  // The service key only builds the database client.
  const uses = live.match(/SUPABASE_SERVICE_ROLE_KEY/g) ?? [];
  assert.equal(uses.length, 1);
});
