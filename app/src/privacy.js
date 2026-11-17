import { createHmac, randomBytes } from 'node:crypto';

/**
 * Identity pseudonymisation.
 *
 * Both modes hash with HMAC-SHA256, but the key differs — and that difference
 * is the entire privacy story:
 *
 *   off   key is 32 random bytes generated at boot and never written anywhere.
 *         Counts are still exact (set dedupe works within the process), but a
 *         hash from today is incomparable to one from tomorrow, and nothing on
 *         disk can be attacked with a rainbow table.
 *
 *   hmac  key comes from HMAC_KEY, so pseudonyms are stable across restarts and
 *         can be ranked over time — at the cost of being a per-member record,
 *         which is exactly why it is opt-in.
 *
 * Discord user IDs are snowflakes: ~1e17 keyspace but highly structured, so a
 * plain unsalted SHA-256 would be brute-forceable in hours. HMAC with a secret
 * key is the difference between "pseudonym" and "encoding".
 */
export function createIdentity({ mode, hmacKey, guildId }) {
  const key =
    mode === 'hmac'
      ? Buffer.from(hmacKey, 'utf8')
      : randomBytes(32);

  const cache = new Map(); // userId -> hmac, bounded
  const MAX_CACHE = 50_000;

  return {
    mode,
    /** Stable for the process lifetime, and across restarts only in hmac mode. */
    keyFor(userId) {
      let v = cache.get(userId);
      if (v) return v;
      if (cache.size >= MAX_CACHE) cache.clear(); // no unbounded growth
      v = createHmac('sha256', key)
        .update(`${guildId}:${userId}`)
        .digest('hex')
        .slice(0, 32);
      cache.set(userId, v);
      return v;
    },
    /** True when a persisted per-member row is permitted. */
    get persistable() {
      return mode === 'hmac';
    },
  };
}
