// The network address behind a report, for the rate limit only.
//
// Only a header the platform itself sets is trusted. "x-forwarded-for" is not one of them: the
// caller can write anything in it, and each request could then carry a new made-up address.
// Cloudflare, in front of the Edge Functions, replaces "cf-connecting-ip" with the address it saw.
// Without it (or a plausible value), there is no address: the per-account and the daily limits
// still apply.

/** The caller's address as the platform saw it, or null. */
export function clientAddress(headers) {
  const value = (headers.get('cf-connecting-ip') ?? '').trim();
  return value.length > 0 && value.length <= 45 && /^[0-9a-fA-F:.]+$/.test(value) ? value : null;
}

/**
 * HMAC-SHA256 of the address with a secret kept for this alone: comparable for the rate limit, not
 * reversible. Null without a usable secret: better no address limit than a hash anybody could redo.
 */
export async function keyedHash(value, secret) {
  if (!value || !secret || secret.length < 16) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
