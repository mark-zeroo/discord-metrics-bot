import { dayOf, isoDate } from './time.js';

const BACKFILL_FLAG = 'backfill.joinedAt.v1';

// REST member listing is paginated at 1000 per page. 100 pages is 100k members:
// far past any guild this is meant for, and a hard stop if `after` ever fails to
// advance.
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

/** Snowflake ordering: compare as BigInt, never as strings. */
function snowflakeAfter(batch) {
  let max = 0n;
  for (const id of batch.keys()) {
    const n = BigInt(id);
    if (n > max) max = n;
  }
  return max === 0n ? null : max.toString();
}

/**
 * Page the member list over REST.
 *
 * `guild.members.fetch()` with no arguments asks the *gateway* to chunk members
 * (opcode 8), which is throttled hard and unpredictably: a 1.1k-member guild can
 * wait 30s and still be refused, and the failure lands on every restart. The REST
 * route (`GET /guilds/{id}/members?after=`) is rate limited per request and
 * retried by discord.js itself, so it succeeds where the chunk request does not.
 */
async function collectMembers(guild, logger) {
  const all = new Map();
  let after = '0';

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await guild.members.list({ limit: PAGE_SIZE, after, cache: false });
    if (!batch || batch.size === 0) break;

    for (const [id, member] of batch) all.set(id, member);

    if (batch.size < PAGE_SIZE) break;

    const next = snowflakeAfter(batch);
    if (next === null || next === after) {
      logger.warn('member pagination did not advance, stopping', { page, after });
      break;
    }
    after = next;
  }

  return all;
}

/**
 * Reconstruct the join curve from `member.joinedAt`.
 *
 * This is the one place where retroactive history exists at all: Discord
 * exposes every current member's join timestamp, so paging the member list once
 * yields the entire historical *gross joins* curve back to server founding.
 *
 * What it cannot tell you: anyone who left. There is no endpoint for departed
 * members, so this is joins and net change, never churn. The API meta block
 * says so explicitly so the model cannot misreport it as retention.
 */
export async function backfillJoinHistory({ guild, db, logger, force = false }) {
  if (!force && db.getMeta(BACKFILL_FLAG)) {
    logger.debug('join-history backfill already complete, skipping');
    return { skipped: true };
  }

  const startedAt = Date.now();
  const members = await collectMembers(guild, logger);

  // An empty result is not a real answer: it would stamp the flag and record a
  // flat baseline as if the server had never gained a member. Leave the flag
  // unset so the next start tries again.
  if (members.size === 0) {
    throw new Error('member listing returned nothing — check DISCORD_GUILD_ID and that the bot is still in that guild');
  }

  const perDay = new Map();
  let bots = 0;

  for (const member of members.values()) {
    if (member.user?.bot) bots += 1;
    const joinedAt = member.joinedAt ?? member.joinedTimestamp;
    if (!joinedAt) continue;
    const ts = Math.floor(new Date(joinedAt).getTime() / 1000);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const d = dayOf(ts);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }

  db.transaction(() => {
    for (const [d, joins] of perDay) {
      db.run(
        `INSERT INTO growth_backfill(day_ts, joins, source) VALUES(?,?,?)
         ON CONFLICT(day_ts) DO UPDATE SET joins = excluded.joins`,
        d,
        joins,
        'joined_at',
      );
    }
    db.setMeta(BACKFILL_FLAG, new Date().toISOString());
    db.setMeta('backfill.members', members.size);
    db.setMeta('backfill.bots', bots);
  });

  const days = perDay.size;
  logger.info('join-history backfill complete', {
    members: members.size,
    bots,
    days,
    first: days ? isoDate(Math.min(...perDay.keys())) : null,
    ms: Date.now() - startedAt,
  });

  return { skipped: false, members: members.size, bots, days };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backfill with bounded retries, so a transient Discord throttle does not leave
 * the join curve empty until the next deploy.
 *
 * Startup must not block on this: it is called after `ready` is logged, and the
 * delays are real waits. Each attempt is idempotent (upsert on day, meta flag on
 * success), so a retry after a partial failure cannot double-count.
 *
 * Returns a result rather than throwing: a missing join curve is a degraded
 * feature, not a reason to take the collector down.
 */
export async function backfillJoinHistoryWithRetry({
  guild,
  db,
  logger,
  attempts = 3,
  delays = [30_000, 120_000],
  sleep = defaultSleep,
  force = false,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await backfillJoinHistory({ guild, db, logger, force });
      return { ok: true, ...result };
    } catch (err) {
      const message = err?.message ?? String(err);
      const isLast = attempt === attempts;
      if (isLast) {
        logger.warn('join-history backfill failed; join curve stays empty until next start', {
          attempt,
          attempts,
          error: message,
        });
        return { ok: false, error: message, attempts };
      }
      const waitMs = delays[attempt - 1] ?? delays[delays.length - 1] ?? 60_000;
      logger.info('join-history backfill failed, retrying', { attempt, attempts, error: message, retryInMs: waitMs });
      await sleep(waitMs);
    }
  }
  return { ok: false, error: 'unreachable', attempts };
}
