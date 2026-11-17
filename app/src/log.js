const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const REDACT_KEYS = /token|secret|authorization|password|hmac|cookie/i;
const BOT_TOKEN = /[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/g;

/** Recursively strip anything that looks like a credential. */
function scrub(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(BOT_TOKEN, '[redacted-token]');
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

/**
 * Deliberately tiny: no transports, no remote sinks, no dependency.
 * stdout gets picked up by the container runtime and rotated there.
 */
export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (name, stream) => (msg, fields) => {
    if (LEVELS[name] > threshold) return;
    const line = { ts: new Date().toISOString(), level: name, msg };
    if (fields !== undefined) line.detail = scrub(fields);
    stream.write(`${JSON.stringify(line)}\n`);
  };

  return {
    error: emit('error', process.stderr),
    warn: emit('warn', process.stderr),
    info: emit('info', process.stdout),
    debug: emit('debug', process.stdout),
  };
}

export const silentLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};
