import { DAY } from './time.js';

/**
 * Flush / prune / checkpoint.
 *
 * Retention is enforced in the writer, not by an external job, so there is one
 * authority on how long data lives. If the numbers in .env say 90 days, nothing
 * on disk is older than 90 days at the next sweep — including WAL pages, which
 * is why the checkpoint is explicit.
 */
export function createMaintenance({ db, config, collectors, bot, logger }) {
  const now = () => Math.floor(Date.now() / 1000);
  let flushTimer = null;
  let pruneTimer = null;
  let lastFlushAt = 0;
  let lastPruneAt = 0;

  function flushAll(ts = now()) {
    try {
      collectors.messages.flush(db, ts);
      collectors.voice.flush(db, ts);
      collectors.members.flush(db, ts);
      lastFlushAt = ts;
      db.setMeta('flush.last', ts);

      // Voice has two silent failure modes — no eligible sessions ever open, or
      // sessions open but accruing nothing — and both look identical from the API:
      // voice_seconds is 0. One debug line per flush makes them distinguishable
      // without guessing from the outside.
      const v = collectors.voice.stats?.();
      if (v) {
        logger.debug('voice collector', {
          countMode: v.countMode,
          activeSessions: v.activeSessions,
          sessionsStarted: v.started,
          pendingHours: v.pendingHours,
          pendingDays: v.pendingDays,
        });
      }
    } catch (err) {
      logger.error('flush failed', { error: err?.message ?? String(err) });
    }
  }

  function prune(ts = now()) {
    const hourlyCutoff = ts - config.storage.retentionHourlyDays * DAY;
    const dailyCutoff = ts - config.storage.retentionDailyDays * DAY;
    const auditCutoff = ts - config.storage.auditRetentionDays * DAY;

    const removed = db.transaction(() => {
      let n = 0;
      const del = (sql, cutoff) => {
        n += Number(db.run(sql, cutoff).changes ?? 0);
      };
      del('DELETE FROM message_hour WHERE hour_ts < ?', hourlyCutoff);
      del('DELETE FROM voice_hour   WHERE hour_ts < ?', hourlyCutoff);
      del('DELETE FROM growth_hour  WHERE hour_ts < ?', hourlyCutoff);
      del('DELETE FROM member_hour  WHERE hour_ts < ?', hourlyCutoff);
      // Per-member daily rows follow daily retention, like the aggregates they
      // mirror. They are per-person, so they must not outlive it.
      del('DELETE FROM member_day   WHERE day_ts < ?', dailyCutoff);
      // Closed membership spans older than daily retention go too: cohort
      // retention cannot be measured there anyway (member_day is gone), and a
      // per-person join record is exactly what should not accumulate forever.
      // Open spans are kept regardless of age — they belong to current members,
      // and deleting one would silently drop that member from every future cohort.
      // Two placeholders, so this cannot go through the single-parameter `del`
      // helper: binding one cutoff and leaving the other unset throws, and a
      // throw here aborts the whole sweep.
      n += Number(
        db.run(
          'DELETE FROM member_tenure WHERE left_ts IS NOT NULL AND left_ts < ? AND joined_ts < ?',
          dailyCutoff,
          dailyCutoff,
        ).changes ?? 0,
      );
      del('DELETE FROM poster_hour  WHERE hour_ts < ?', hourlyCutoff);
      del('DELETE FROM snapshot     WHERE ts < ?', hourlyCutoff);
      del('DELETE FROM message_day  WHERE day_ts < ?', dailyCutoff);
      del('DELETE FROM voice_day    WHERE day_ts < ?', dailyCutoff);
      del('DELETE FROM growth_day   WHERE day_ts < ?', dailyCutoff);
      // Exact poster counts are cheap scalars, so they follow daily retention
      // rather than hourly: the whole point is a long historical headcount.
      del('DELETE FROM poster_day   WHERE day_ts < ?', dailyCutoff);
      del('DELETE FROM api_audit    WHERE ts < ?', auditCutoff);
      return n;
    });

    lastPruneAt = ts;
    db.setMeta('prune.last', ts);

    if (removed > 0) logger.info('retention sweep', { rows: removed });

    // Weekly compaction keeps the file from ratcheting upward after pruning.
    const lastVacuum = Number(db.getMeta('vacuum.last') ?? 0);
    if (ts - lastVacuum > 7 * DAY) {
      try {
        db.run('PRAGMA wal_checkpoint(TRUNCATE)');
        db.raw.exec('VACUUM');
        db.setMeta('vacuum.last', ts);
        logger.info('vacuum complete');
      } catch (err) {
        logger.warn('vacuum failed', { error: err?.message ?? String(err) });
      }
    }

    return removed;
  }

  return {
    flushAll,
    prune,

    start() {
      flushTimer = setInterval(() => flushAll(), config.runtime.flushIntervalMs);
      flushTimer.unref?.();

      // Sweep at boot, then on MAINTENANCE_INTERVAL_MINUTES (default hourly).
      prune();
      pruneTimer = setInterval(() => {
        prune();
        bot?.refreshScheduledEvents?.();
        bot?.refreshChannelNames?.();
      }, config.runtime.maintenanceIntervalMs);
      pruneTimer.unref?.();
    },

    stop() {
      if (flushTimer) clearInterval(flushTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      flushAll();
    },

    stats() {
      return { lastFlushAt, lastPruneAt, ...collectors.messages.stats(), voice: collectors.voice.stats() };
    },
  };
}
