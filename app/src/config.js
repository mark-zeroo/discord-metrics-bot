import { isIP } from 'node:net';
import path from 'node:path';

const SNOWFLAKE = /^\d{5,20}$/;
const PRIVATE_V4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::']);

class ConfigError extends Error {}

function str(env, name, { fallback = undefined, required = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (required) throw new ConfigError(`missing required env var ${name}`);
    return fallback;
  }
  return raw.trim();
}

function int(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ConfigError(`${name} must be an integer`);
  if (n < min || n > max)
    throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return n;
}

function bool(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`${name} must be a boolean`);
}

function list(env, name) {
  const raw = str(env, name, { fallback: '' });
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Storage-only subset, for operator CLIs that touch the database but never the
 * gateway (`repair`, `tag`, `token`). Requiring DISCORD_TOKEN to run a data
 * repair would be a papercut with no upside.
 */
export function loadStorageConfig(env = process.env) {
  // DATA_DIR is the container's single mount point; DB_PATH / TOKENS_FILE win
  // when they are set, so a local run can keep everything in one directory.
  const dataDir = str(env, 'DATA_DIR', { fallback: '/data' });
  return {
    dbPath: str(env, 'DB_PATH', { fallback: path.join(dataDir, 'metrics.db') }),
    tokensFile: str(env, 'TOKENS_FILE', { fallback: path.join(dataDir, 'tokens.json') }),
    retentionHourlyDays: int(env, 'RETENTION_HOURLY_DAYS', 90, { min: 2, max: 3650 }),
    retentionDailyDays: int(env, 'RETENTION_DAILY_DAYS', 730, { min: 7, max: 36500 }),
    auditRetentionDays: int(env, 'AUDIT_RETENTION_DAYS', 30, { min: 1, max: 3650 }),
    // How long a writer waits on a locked database before SQLITE_BUSY. The API
    // and the collector share one file, so this is the knob that trades latency
    // against "busy" errors under a backup or a big retention sweep.
    dbBusyTimeoutMs: int(env, 'DB_BUSY_TIMEOUT_MS', 5000, { min: 100, max: 120000 }),
  };
}

/**
 * Everything is validated here and nowhere else, so a bad env fails at boot
 * instead of at 3am inside an event handler.
 */
export function loadConfig(env = process.env) {
  const discordToken = str(env, 'DISCORD_TOKEN', { required: true });
  const guildId = str(env, 'DISCORD_GUILD_ID', { required: true });

  if (!SNOWFLAKE.test(guildId)) {
    throw new ConfigError('DISCORD_GUILD_ID must be a numeric snowflake');
  }
  // A bot token is three base64url segments; a client secret is not a token.
  if (discordToken.split('.').length !== 3) {
    throw new ConfigError('DISCORD_TOKEN does not look like a bot token');
  }

  const apiHost = str(env, 'API_HOST', { fallback: '127.0.0.1' });
  const allowPublicBind = bool(env, 'ALLOW_PUBLIC_BIND', false);

  if (!LOOPBACK.has(apiHost) && apiHost !== '0.0.0.0' && !PRIVATE_V4.test(apiHost)) {
    throw new ConfigError(
      `API_HOST ${apiHost} is not a loopback or private address; refusing to bind`,
    );
  }
  const isPublicBind = apiHost === '0.0.0.0' || (!LOOPBACK.has(apiHost) && !PRIVATE_V4.test(apiHost));
  if (isPublicBind && !allowPublicBind) {
    throw new ConfigError(
      'API_HOST is not loopback. Set ALLOW_PUBLIC_BIND=true only if the port is ' +
        'not reachable from untrusted networks (e.g. inside a container).',
    );
  }

  const perMemberCounters = str(env, 'PER_MEMBER_COUNTERS', { fallback: 'off' }).toLowerCase();
  if (!['off', 'hmac'].includes(perMemberCounters)) {
    throw new ConfigError("PER_MEMBER_COUNTERS must be 'off' or 'hmac'");
  }
  const hmacKey = str(env, 'HMAC_KEY', { fallback: '' });
  if (!['present', 'unmuted'].includes(str(env, 'VOICE_COUNT_MODE', { fallback: 'present' }).toLowerCase())) {
    throw new Error(
      "VOICE_COUNT_MODE must be 'present' (anyone in a non-AFK channel) or " +
        "'unmuted' (only unmuted, undeafened members)",
    );
  }
  if (perMemberCounters === 'hmac' && Buffer.from(hmacKey, 'utf8').length < 32) {
    throw new ConfigError(
      'PER_MEMBER_COUNTERS=hmac requires HMAC_KEY of at least 32 bytes (openssl rand -hex 32)',
    );
  }

  const allowedIps = list(env, 'API_ALLOWED_IPS');
  for (const entry of allowedIps) {
    const [addr, bits] = entry.split('/');
    if (!isIP(addr)) throw new ConfigError(`API_ALLOWED_IPS entry is not an IP: ${entry}`);
    if (bits !== undefined && !/^\d{1,3}$/.test(bits)) {
      throw new ConfigError(`API_ALLOWED_IPS has a bad prefix length: ${entry}`);
    }
  }

  const eventBaselineDays = int(env, 'EVENT_BASELINE_DAYS', 28, { min: 7, max: 365 });
  const eventBaselineNoisyDays = int(env, 'EVENT_BASELINE_NOISY_DAYS', 14, { min: 1, max: 365 });
  if (eventBaselineNoisyDays > eventBaselineDays) {
    throw new ConfigError('EVENT_BASELINE_NOISY_DAYS cannot exceed EVENT_BASELINE_DAYS');
  }

  // The anonymity floor for any published cross-tab of people. It is validated
  // here because a value of 1 silently turns every guard off while still
  // appearing configured, and 0 would make `count < k` impossible to satisfy.
  const minCell = int(env, 'PRIVACY_MIN_CELL', 10, { min: 2, max: 1000 });
  const eventMatchedMinDays = int(env, 'EVENT_MATCHED_MIN_DAYS', 3, { min: 1, max: 52 });
  // A weekday cannot appear more often than the baseline is long, so a floor above
  // the window length (28 days holds 4 of each weekday) makes every uplift refuse
  // for a reason that looks like a data problem. Fail at boot instead.
  if (eventMatchedMinDays > eventBaselineDays) {
    throw new ConfigError('EVENT_MATCHED_MIN_DAYS cannot exceed EVENT_BASELINE_DAYS');
  }

  // Core size as a fraction of active members. 0.2 is the "top fifth", which on
  // a community server is roughly the regulars. Bounded well below 1 because a
  // "core" of everyone measures nothing.
  const coreShare = Number(str(env, 'CORE_SHARE', { fallback: '0.2' }));
  if (!Number.isFinite(coreShare) || coreShare <= 0.02 || coreShare >= 0.5) {
    throw new ConfigError('CORE_SHARE must be a number between 0.02 and 0.5');
  }

  return {
    discord: { token: discordToken, guildId },
    api: {
      host: apiHost,
      port: int(env, 'API_PORT', 8283, { min: 1, max: 65535 }),
      allowedIps,
      rateLimitPerMin: int(env, 'RATE_LIMIT_PER_MIN', 60, { min: 1, max: 100000 }),
      // Hard cap on `?top=`, so a caller cannot ask for a response that the size
      // cap would then reject. 10 is plenty for a chart; raise it deliberately.
      maxTop: int(env, 'API_MAX_TOP', 10, { min: 1, max: 100 }),
      // A single response larger than this is replaced with a 500 and logged,
      // rather than streamed to a model that will truncate it anyway.
      maxResponseBytes: int(env, 'API_MAX_RESPONSE_KB', 256, { min: 8, max: 8192 }) * 1024,
      // Audit rows are buffered and written in batches; they are diagnostics, so
      // a lost batch on SIGKILL costs nothing worth a synchronous write per call.
      auditFlushMs: int(env, 'AUDIT_FLUSH_SECONDS', 10, { min: 1, max: 600 }) * 1000,
      auditBufferRows: int(env, 'AUDIT_BUFFER_ROWS', 500, { min: 10, max: 100000 }),
      publicBindAcknowledged: allowPublicBind,
    },
    storage: loadStorageConfig(env),
    privacy: {
      perMemberCounters,
      hmacKey,
      perChannelMetrics: bool(env, 'PER_CHANNEL_METRICS', true),
      excludedRoleIds: list(env, 'EXCLUDED_ROLE_IDS'),
      // What counts as being "in voice". 'present' counts anyone sitting in a
      // non-AFK channel, including muted and deafened members — the normal way to
      // sit in a lobby while playing on a phone. 'unmuted' requires an unmuted,
      // undeafened member, which measures something closer to conversation.
      voiceCountMode: str(env, 'VOICE_COUNT_MODE', { fallback: 'present' }).toLowerCase(),
      // Minimum cell size k for every published cross-tab of people (cohort
      // retention, core churn, engagement bands). Cells below it are withheld,
      // and totals that would let a withheld cell be recovered by subtraction
      // are withheld too. Never a display rounding knob: it is the anonymity floor.
      minCell,
    },
    runtime: {
      flushIntervalMs: int(env, 'FLUSH_INTERVAL_MS', 15000, { min: 1000, max: 300000 }),
      // Presence polling and the retention sweep are long intervals, so they are
      // configured in whole minutes rather than milliseconds.
      snapshotIntervalMs:
        int(env, 'SNAPSHOT_INTERVAL_MINUTES', 10, { min: 1, max: 1440 }) * 60_000,
      maintenanceIntervalMs:
        int(env, 'MAINTENANCE_INTERVAL_MINUTES', 60, { min: 1, max: 1440 }) * 60_000,
      readyTimeoutMs: int(env, 'READY_TIMEOUT_SECONDS', 30, { min: 5, max: 300 }) * 1000,
      logLevel: str(env, 'LOG_LEVEL', { fallback: 'info' }),
    },
    analytics: {
      eventBaselineDays,
      eventBaselineNoisyDays,
      // How many complete periods the core trend looks back over, and what
      // fraction of active members counts as "core".
      corePeriods: int(env, 'CORE_PERIODS', 8, { min: 2, max: 52 }),
      coreShare,
      // Core concentration is only reported as a direction with this many
      // published periods behind it: two points are a line through noise.
      coreMinPeriodsForTrend: 4,
      presenceStaleSeconds: int(env, 'PRESENCE_STALE_MINUTES', 30, { min: 1, max: 1440 }) * 60,
      // Channel lifecycle thresholds. A channel is dormant after this many days
      // without traffic, and needs this many messages in the window before a
      // growing/declining call is made at all (otherwise a 3-message channel
      // reads as "in decline" rather than "too quiet to say").
      channelDormantDays: int(env, 'CHANNEL_DORMANT_DAYS', 21, { min: 2, max: 365 }),
      channelMinMessages: int(env, 'CHANNEL_MIN_MESSAGES', 20, { min: 1, max: 100000 }),
      // Uplift refuses to divide tiny numbers. Below this many messages in the
      // event window or in the baseline, the ratio is noise wearing a decimal.
      eventUpliftMinMessages: int(env, 'EVENT_UPLIFT_MIN_MESSAGES', 30, { min: 0, max: 100000 }),
      // How many baseline days per weekday are needed before a weekday-matched
      // baseline is trusted. 28 baseline days gives 4 per weekday.
      eventMatchedMinDays,
    },
  };
}

export { ConfigError };
