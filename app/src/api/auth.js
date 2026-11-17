import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

export const SCOPES = Object.freeze({
  READ: 'stats:read',
});

/** Tokens are never stored, logged, or compared in plaintext. */
export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function loadTokenFile(tokensFile) {
  let raw;
  try {
    raw = fs.readFileSync(tokensFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { tokens: [], error: `no token file at ${tokensFile}` };
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { tokens: [], error: `token file at ${tokensFile} is not valid JSON` };
  }

  const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
  const valid = [];
  for (const t of tokens) {
    if (typeof t?.hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.hash)) continue;
    if (t.revoked_at) continue;
    valid.push({
      id: String(t.id ?? 'unknown'),
      label: String(t.label ?? ''),
      hash: t.hash,
      scopes: Array.isArray(t.scopes) && t.scopes.length ? t.scopes.map(String) : [SCOPES.READ],
    });
  }
  return { tokens: valid, error: null };
}

/** Constant-time match against every candidate; no early exit on id. */
function matchToken(candidateHash, tokens) {
  const buf = Buffer.from(candidateHash, 'hex');
  let found = null;
  for (const token of tokens) {
    const stored = Buffer.from(token.hash, 'hex');
    if (stored.length !== buf.length) continue;
    if (timingSafeEqual(stored, buf)) found = token; // keep looping: no timing oracle on position
  }
  return found;
}

export function ipAllowed(peer, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  const normalised = String(peer ?? '').replace(/^::ffff:/, '');
  for (const entry of allowlist) {
    const [addr, bitsStr] = entry.split('/');
    if (!bitsStr) {
      if (addr === normalised) return true;
      continue;
    }
    if (addr.includes(':')) {
      // IPv6 prefixes are compared literally; this API is v4-only in practice.
      if (normalised.startsWith(addr)) return true;
      continue;
    }
    const bits = Number(bitsStr);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    const a = ipv4ToInt(addr);
    const b = ipv4ToInt(normalised);
    if (a !== null && b !== null && (a & mask) === (b & mask)) return true;
  }
  return false;
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/**
 * Auth decisions are pure given (token, peer) so they can be tested without a
 * socket. Rate limiting is in-memory and per token: a model that hammers the
 * endpoint degrades itself, not the reader.
 */
/**
 * Serves the token set, re-reading the file when its mtime changes.
 *
 * Revocation has to be immediate or it is not really revocation, so a `revoke`
 * takes effect on the next request without a restart. The check is throttled to
 * one stat() per interval to keep it off the hot path.
 *
 * If the file becomes unreadable we keep serving the last good set: the
 * documented way to revoke is `npm run token -- revoke`, which rewrites the file
 * atomically, so a read error means a mount or disk problem rather than an
 * intentional lockdown.
 */
export function createTokenStore({
  tokensFile = null,
  tokens = [],
  reloadIntervalMs = 5_000,
  now = () => Date.now(),
} = {}) {
  let current = tokens;
  let lastCheck = 0;
  let lastMtime = -1;

  return {
    get tokens() {
      if (!tokensFile) return current;

      const t = now();
      if (t - lastCheck < reloadIntervalMs) return current;
      lastCheck = t;

      try {
        const { mtimeMs } = fs.statSync(tokensFile);
        if (mtimeMs === lastMtime) return current;
        lastMtime = mtimeMs;

        const { tokens: loaded, error } = loadTokenFile(tokensFile);
        if (!error) current = loaded;
      } catch {
        // Missing or unreadable: keep the last good set.
      }

      return current;
    },
  };
}

export function createAuthenticator({
  tokens,
  store = null,
  rateLimitPerMin = 60,
  allowedIps = [],
  now = () => Date.now(),
}) {
  const buckets = new Map(); // tokenId -> {windowStart, count}

  function rateLimited(tokenId) {
    const t = now();
    const windowStart = Math.floor(t / 60000) * 60000;
    let bucket = buckets.get(tokenId);
    if (!bucket || bucket.windowStart !== windowStart) {
      bucket = { windowStart, count: 0 };
      buckets.set(tokenId, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 1000) {
      for (const [k, v] of buckets) if (v.windowStart !== windowStart) buckets.delete(k);
    }
    return bucket.count > rateLimitPerMin;
  }

  return {
    /** @returns {{ok:true, tokenId:string, scopes:string[]} | {ok:false, status:number, error:string, tokenId:string|null}} */
    authenticate(req) {
      const peer = req.socket?.remoteAddress ?? '';
      if (!ipAllowed(peer, allowedIps)) {
        return { ok: false, status: 403, error: 'forbidden', tokenId: null };
      }

      const header = req.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
        return { ok: false, status: 401, error: 'unauthorized', tokenId: null };
      }

      const presented = header.slice(7).trim();
      // Cheap shape check before hashing: a bearer token here is always 43
      // base64url chars from scripts/issue-token.mjs.
      if (!/^[A-Za-z0-9_-]{43}$/.test(presented)) {
        return { ok: false, status: 401, error: 'unauthorized', tokenId: null };
      }

      // `store` is live (mtime-checked), `tokens` is the static set used in tests.
      const token = matchToken(hashToken(presented), store ? store.tokens : tokens);
      if (!token) return { ok: false, status: 401, error: 'unauthorized', tokenId: null };

      if (rateLimited(token.id)) {
        return { ok: false, status: 429, error: 'rate_limited', tokenId: token.id };
      }

      return { ok: true, tokenId: token.id, scopes: token.scopes };
    },
  };
}
