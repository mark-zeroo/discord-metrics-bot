import fs from 'node:fs';

import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './log.js';
import { markDayPartial, openDb } from './db.js';
import { createIdentity } from './privacy.js';
import { createMessageCollector } from './collectors/messages.js';
import { createVoiceCollector } from './collectors/voice.js';
import { createMemberCollector } from './collectors/members.js';
import { createBot } from './bot.js';
import { createApiServer } from './api/server.js';
import { createMaintenance } from './maintenance.js';
import { backfillJoinHistoryWithRetry } from './backfill.js';
import { dayOf, isoDate } from './time.js';

/**
 * One line that answers "am I still looking at my history?"
 *
 * A wrong volume or a switched mount path looks exactly like a normal start: the
 * schema is created, collection begins, nothing errors. The only external tell is
 * the row count, so report it every boot rather than making the operator go
 * digging through `docker volume ls`.
 */
function describeStore(db) {
  const row = db.get('SELECT COUNT(*) AS n, MIN(day_ts) AS first, MAX(day_ts) AS last FROM message_day');
  let bytes = null;
  try {
    bytes = fs.statSync(db.path).size;
  } catch {
    /* in-memory or unreadable: leave null rather than lie */
  }
  return {
    path: db.path,
    createdNow: db.createdNow,
    bytes,
    messageDays: row?.n ?? 0,
    firstDay: row?.first ? isoDate(row.first) : null,
    lastDay: row?.last ? isoDate(row.last) : null,
  };
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Structured, no secret echo, non-zero exit so the supervisor notices.
      process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'config invalid', detail: err.message })}\n`);
      process.exit(2);
    }
    throw err;
  }

  const logger = createLogger(config.runtime.logLevel);
  const db = openDb(config.storage.dbPath, { busyTimeoutMs: config.storage.dbBusyTimeoutMs });

  const store = describeStore(db);
  if (store.createdNow) {
    logger.warn('database file created — no prior history at this path', store);
  } else {
    logger.info('database opened', store);
  }

  if (!db.getMeta('boot.first')) db.setMeta('boot.first', new Date().toISOString());
  db.setMeta('boot.last', new Date().toISOString());
  db.setMeta('boot.count', String(Number(db.getMeta('boot.count') ?? 0) + 1));

  // Whatever happened between midnight and now was counted by a process that is
  // gone, so today's rows are a lower bound whatever their own flag says. The
  // collectors can only flag rows they rewrite, so repair the rest here — a boot
  // is the one moment we know for certain the day was observed in two pieces.
  markDayPartial(db, dayOf(Math.floor(Date.now() / 1000)));

  const identity = createIdentity({
    mode: config.privacy.perMemberCounters,
    hmacKey: config.privacy.hmacKey,
    guildId: config.discord.guildId,
  });

  const collectors = {
    messages: createMessageCollector({
      identity,
      excludedRoleIds: new Set(config.privacy.excludedRoleIds),
      perChannel: config.privacy.perChannelMetrics,
    }),
    voice: createVoiceCollector({
      identity,
      excludedRoleIds: new Set(config.privacy.excludedRoleIds),
      afkChannelId: null, // resolved once the guild is available
      countMode: config.privacy.voiceCountMode,
    }),
    members: createMemberCollector(),
  };

  const api = createApiServer({ config, db, logger, collectors });
  const bot = createBot({ config, db, collectors, logger });
  const maintenance = createMaintenance({ db, config, collectors, bot, logger });

  await api.listen();
  maintenance.start();

  logger.info('starting gateway login', { guildId: config.discord.guildId });

  // start() resolves only after the clientReady handler has populated the guild
  // cache. Awaiting login alone leaves `bot.guild` null on every boot, because
  // Client#login settles when the websocket opens, not when READY is parsed.
  const guild = await bot.start();
  if (!guild) {
    logger.error('no guild after login; refusing to run');
    process.exit(1);
  }

  collectors.voice.abandonAll(logger);
  collectors.voice.setAfkChannel(guild.afkChannelId);

  // Members already sitting in a voice channel never emit voiceStateUpdate, so
  // adopt them here. Without this, every redeploy stranded whoever was in a call
  // until they muted, moved or left, and their minutes went uncounted. Must run
  // after abandonAll (which clears sessions) and after the AFK channel is known
  // (so nobody parked in AFK is adopted as a participant).
  const adopted = collectors.voice.seed(guild);
  // Log even when nothing was adopted. A missing line and a zero were previously
  // indistinguishable in the logs, so "did the re-adoption run?" could not be
  // answered from the outside when voice totals stalled after a restart.
  logger.info('voice sessions adopted on boot', {
    sessions: adopted,
    voice_states: guild.voiceStates?.cache?.size ?? 0,
  });

  // The boot seed can race the member fetch: a voice state with no member object
  // resolves to null and is skipped, which reads exactly like an idle server. seed()
  // is idempotent (it skips members that already have a session), so retrying is free
  // and only ever adds sessions that were missed.
  for (const delayMs of [10000, 30000]) {
    setTimeout(() => {
      try {
        const late = collectors.voice.seed(guild);
        if (late) {
          logger.info('adopted voice sessions on late seed', { sessions: late, afterMs: delayMs });
        }
      } catch (err) {
        logger.warn('late voice seed failed', { error: err?.message ?? String(err) });
      }
    }, delayMs).unref();
  }

  // Seed a snapshot immediately so the first API call has a member count.
  await bot.pollSnapshot();

  logger.info('ready', {
    privacy: config.privacy.perMemberCounters,
    retention: config.storage,
    flushMs: config.runtime.flushIntervalMs,
  });

  let shuttingDown = false;

  // One-shot: reconstruct the join curve from member join dates. Deliberately not
  // awaited — it retries with real delays, and blocking startup on it would push
  // `ready` (and the first flush) out by minutes on a throttled guild.
  void backfillJoinHistoryWithRetry({ guild, db, logger }).then((result) => {
    if (shuttingDown) return;
    try {
      if (result.ok && !result.skipped) db.setMeta('backfill.completed', new Date().toISOString());
    } catch (err) {
      logger.debug('could not record backfill completion', { error: err?.message });
    }
  });

  const shutdown = async (signal) => {
    shuttingDown = true;
    logger.info('shutting down', { signal });
    try {
      maintenance.stop();
    } catch (err) {
      logger.error('flush on shutdown failed', { error: err?.message });
    }
    try {
      await bot.stop();
    } catch {
      /* ignore */
    }
    try {
      await api.close();
    } catch {
      /* ignore */
    }
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: String(reason?.message ?? reason) });
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception — exiting for supervisor restart', {
      error: err?.message ?? String(err),
      stack: err?.stack?.split('\n').slice(0, 5).join(' | '),
    });
    try {
      maintenance.flushAll();
      db.close();
    } catch {
      /* nothing left to save */
    }
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'fatal', detail: String(err?.message ?? err) })}\n`,
  );
  process.exit(1);
});
