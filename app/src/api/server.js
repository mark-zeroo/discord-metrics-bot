import http from 'node:http';
import { createAuthenticator, createTokenStore, loadTokenFile } from './auth.js';
import {
  ParamError,
  parseWindow,
  parseBucket,
  parseIntParam,
  maxTop,
  rejectUnknownParams,
} from './params.js';
import * as Q from './queries.js';

// Both come from config (API_MAX_RESPONSE_KB / AUDIT_FLUSH_SECONDS); these are
// only the values used when a caller builds the server without a config object.
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_AUDIT_FLUSH_MS = 10_000;

const SECURITY_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

/**
 * Read-only HTTP surface.
 *
 * Properties that are structural, not conventions:
 *   - No route mutates state. There is no POST/PUT/PATCH/DELETE handler at all.
 *   - Authentication precedes parsing, so unauthenticated callers cannot use
 *     error messages as an oracle for what exists.
 *   - The listening socket is bound to loopback by default; see config.js.
 *   - Responses are small and bounded so a hostile caller cannot make the
 *     process allocate its way into an OOM kill.
 */
export function createApiServer({ config, db, logger, collectors = null }) {
  const { tokens, error: tokenError } = loadTokenFile(config.storage.tokensFile);
  if (tokenError) {
    logger.error('API tokens unavailable — the HTTP API will refuse every request', {
      reason: tokenError,
      hint: 'run: npm run token -- issue --label openwebui',
    });
  } else {
    logger.info('API tokens loaded', { count: tokens.length });
  }

  const auth = createAuthenticator({
    tokens,
    store: createTokenStore({ tokensFile: config.storage.tokensFile, tokens }),
    rateLimitPerMin: config.api.rateLimitPerMin,
    allowedIps: config.api.allowedIps,
  });

  // Both caps are operator-tunable (API_MAX_RESPONSE_KB, AUDIT_*), but fall back
  // to the defaults so a hand-built config object still works.
  const maxResponseBytes = config.api.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const auditFlushMs = config.api.auditFlushMs ?? DEFAULT_AUDIT_FLUSH_MS;
  const auditBufferRows = config.api.auditBufferRows ?? 500;
  const maxTopLimit = config.api.maxTop;

  const auditBuffer = [];
  let inflight = 0;

  const routes = {
    'GET /healthz': () => ({ ok: true, up: true }),

    'GET /v1/meta': (_params, ts) => Q.meta(db, config, ts),

    'GET /v1/summary': (params, ts) => {
      rejectUnknownParams(params, ['window']);
      return Q.summary(db, config, { window: parseWindow(params), ts });
    },

    'GET /v1/growth': (params, ts) => {
      rejectUnknownParams(params, ['window', 'bucket']);
      return Q.growth(db, config, {
        window: parseWindow(params, '90d'),
        bucket: parseBucket(params),
        ts,
      });
    },

    'GET /v1/activity': (params, ts) => {
      rejectUnknownParams(params, ['window', 'bucket', 'top']);
      return Q.activity(db, config, {
        window: parseWindow(params),
        bucket: parseBucket(params),
        top: maxTop(params, maxTopLimit),
        ts,
      });
    },

    'GET /v1/voice': (params, ts) => {
      rejectUnknownParams(params, ['window', 'bucket', 'top']);
      return Q.voice(db, config, {
        window: parseWindow(params),
        bucket: parseBucket(params),
        top: maxTop(params, maxTopLimit),
        ts,
      });
    },

    'GET /v1/tags': (params, ts) => {
      rejectUnknownParams(params, ['limit']);
      return Q.tags(db, config, { limit: parseIntParam(params, 'limit', 20, 1, 50), ts });
    },

    'GET /v1/engagement': (params, ts) => {
      rejectUnknownParams(params, ['window']);
      return Q.engagement(db, config, { window: parseWindow(params), ts });
    },

    'GET /v1/events': (params, ts) => {
      rejectUnknownParams(params, []);
      return Q.events(db, config, { ts });
    },

    'GET /v1/presence': (params, ts) => {
      rejectUnknownParams(params, []);
      return Q.presence(db, config, { ts });
    },

    'GET /v1/structure': (params, ts) => {
      rejectUnknownParams(params, ['window', 'detail']);
      const detail = params.get('detail') ?? 'summary';
      if (!['summary', 'full'].includes(detail)) {
        throw new ParamError("detail must be 'summary' or 'full'");
      }
      return Q.structure(db, config, { window: parseWindow(params), detail, ts });
    },

    'GET /v1/quality': (params, ts) => {
      rejectUnknownParams(params, []);
      // Live collector state, not stored data: whether a voice session is open
      // *right now* is the question a frozen voice_seconds raises, and nothing
      // outside the process could answer it before.
      const voiceStats = collectors?.voice?.stats?.() ?? null;
      return Q.qualityReport(db, config, { ts, voiceStats });
    },
  };

  const knownPaths = new Set(Object.keys(routes).map((k) => k.split(' ')[1]));

  function send(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    if (payload.length > maxResponseBytes) {
      logger.error('response exceeded size cap', { bytes: payload.length });
      status = 500;
      body = { error: 'response_too_large' };
    }
    const final = status === 500 && body?.error === 'response_too_large'
      ? JSON.stringify(body)
      : payload;
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-length': Buffer.byteLength(final), ...extraHeaders });
    res.end(final);
  }

  const server = http.createServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    const ts = Math.floor(Date.now() / 1000);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const routeKey = `${req.method} ${path}`;

    const finish = (status, tokenId) => {
      const ms = Number((process.hrtime.bigint() - startedAt) / 1000000n);
      auditBuffer.push({
        ts,
        tokenId: tokenId ?? null,
        route: path.slice(0, 120),
        query: url.search.slice(0, 200) || null,
        status,
        ms,
        peer: String(req.socket?.remoteAddress ?? '').slice(0, 60),
      });
      if (auditBuffer.length > auditBufferRows) flushAudit();
    };

    // Only GET exists. Anything else is refused before any parsing.
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      send(res, 405, { error: 'method_not_allowed' });
      finish(405, null);
      req.resume();
      return;
    }

    if (!routes[routeKey]) {
      if (knownPaths.has(path)) {
        res.setHeader('allow', 'GET');
        send(res, 405, { error: 'method_not_allowed' });
        finish(405, null);
      } else {
        send(res, 404, { error: 'not_found' });
        finish(404, null);
      }
      req.resume();
      return;
    }

    // /healthz is unauthenticated on purpose: it is the container probe and
    // exposes nothing but liveness.
    if (path === '/healthz') {
      send(res, 200, routes[routeKey](url.searchParams, ts));
      finish(200, null);
      return;
    }

    const decision = auth.authenticate(req);
    if (!decision.ok) {
      const extra = decision.status === 429 ? { 'retry-after': '60' } : {};
      send(res, decision.status, { error: decision.error }, extra);
      finish(decision.status, decision.tokenId);
      return;
    }

    if (!decision.scopes.includes('stats:read')) {
      send(res, 403, { error: 'forbidden' });
      finish(403, decision.tokenId);
      return;
    }

    if (inflight > 32) {
      send(res, 503, { error: 'busy' });
      finish(503, decision.tokenId);
      return;
    }

    inflight += 1;
    try {
      const body = routes[routeKey](url.searchParams, ts);
      send(res, 200, body);
      finish(200, decision.tokenId);
    } catch (err) {
      if (err instanceof ParamError) {
        send(res, 400, { error: 'bad_request', detail: err.message });
        finish(400, decision.tokenId);
      } else {
        // Never leak internals to the caller; the detail goes to the log only.
        logger.error('handler failed', {
          route: routeKey,
          error: err?.message ?? String(err),
          stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
        });
        send(res, 500, { error: 'internal_error' });
        finish(500, decision.tokenId);
      }
    } finally {
      inflight -= 1;
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 10_000;

  function flushAudit() {
    if (auditBuffer.length === 0) return 0;
    const batch = auditBuffer.splice(0, auditBuffer.length);
    try {
      db.transaction(() => {
        for (const row of batch) {
          db.run(
            `INSERT INTO api_audit(ts, token_id, route, query, status, ms, peer)
             VALUES(?,?,?,?,?,?,?)`,
            row.ts,
            row.tokenId,
            row.route,
            row.query,
            row.status,
            row.ms,
            row.peer,
          );
        }
      });
    } catch (err) {
      logger.error('audit flush failed', { error: err?.message, dropped: batch.length });
    }
    return batch.length;
  }

  const auditTimer = setInterval(flushAudit, auditFlushMs);
  auditTimer.unref?.();

  return {
    server,
    flushAudit,

    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.api.port, config.api.host, () => {
          server.removeListener('error', reject);
          const { address, port } = server.address();
          logger.info('api listening', {
            address,
            port,
            publicBind: config.api.publicBindAcknowledged,
            ipAllowlist: config.api.allowedIps.length,
          });
          if (config.api.publicBindAcknowledged) {
            logger.warn(
              'API is bound to a non-loopback address; the token is the only access control',
              { allowedIps: config.api.allowedIps },
            );
          }
          resolve({ address, port });
        });
      });
    },

    async close() {
      clearInterval(auditTimer);
      flushAudit();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(resolve, 2000).unref?.();
      });
    },
  };
}
