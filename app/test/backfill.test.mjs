import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { backfillJoinHistory, backfillJoinHistoryWithRetry } from '../src/backfill.js';
import { dayOf } from '../src/time.js';

const DAY = 86400;

function silentLogger() {
  const seen = [];
  const record = (level) => (msg, detail) => seen.push({ level, msg, detail });
  return {
    seen,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

/**
 * A fake guild whose member list paginates the way Discord's REST endpoint does:
 * `<limit>` per page, resuming after the last snowflake seen.
 */
function fakeGuild(allMembers, { pageErrors = [] } = {}) {
  const calls = [];
  let errorIndex = 0;

  return {
    calls,
    members: {
      async list({ limit, after }) {
        calls.push({ limit, after });
        if (errorIndex < pageErrors.length) {
          const err = pageErrors[errorIndex];
          errorIndex += 1;
          throw err;
        }
        const afterId = BigInt(after);
        const page = allMembers
          .filter(([id]) => BigInt(id) > afterId)
          .slice(0, limit);
        return new Map(page);
      },
    },
  };
}

/** 2500 members, one per 40 minutes going back from now. */
function membersBackInTime(count, joinedAtStart) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const id = (100000000000000000n + BigInt(i)).toString();
    const joinedAt = new Date((joinedAtStart + i * 40 * 60) * 1000).toISOString();
    out.push([id, { id, joinedAt, user: { bot: false } }]);
  }
  return out;
}

test('join backfill pages the REST member list instead of requesting a gateway chunk', async () => {
  // 2500 members is 3 pages at 1000/page. The old implementation called
  // guild.members.fetch(), which asks the gateway for a chunk (opcode 8) and gets
  // rate limited on a 1.1k-member guild, leaving the join curve empty.
  const start = 1_700_000_000 - 2500 * 40 * 60;
  const guild = fakeGuild(membersBackInTime(2500, start));
  assert.equal(guild.members.fetch, undefined, 'the fake guild must not offer the chunk path');

  const db = openDb(':memory:');
  const logger = silentLogger();

  const result = await backfillJoinHistory({ guild, db, logger });

  assert.equal(result.skipped, false);
  assert.equal(result.members, 2500);
  assert.ok(result.days >= 3, `expected several joined-on days, got ${result.days}`);
  assert.deepEqual(
    guild.calls.map((c) => c.limit),
    [1000, 1000, 1000],
    'stops once a short page is returned',
  );
  assert.equal(guild.calls[0].after, '0');

  const total = db.get('SELECT COALESCE(SUM(joins),0) AS n FROM growth_backfill').n;
  assert.equal(total, 2500);
  assert.ok(db.getMeta('backfill.joinedAt.v1'));
  assert.equal(String(db.getMeta('backfill.members')), '2500');
  db.close();
});

test('join backfill skips once the flag is set, and force re-runs it', async () => {
  const guild = fakeGuild(membersBackInTime(10, 1_700_000_000));
  const db = openDb(':memory:');
  const logger = silentLogger();

  await backfillJoinHistory({ guild, db, logger });
  const callsAfterFirst = guild.calls.length;

  const second = await backfillJoinHistory({ guild, db, logger });
  assert.equal(second.skipped, true);
  assert.equal(guild.calls.length, callsAfterFirst, 'no listing when already complete');

  const forced = await backfillJoinHistory({ guild, db, logger, force: true });
  assert.equal(forced.skipped, false);
  assert.equal(guild.calls.length, callsAfterFirst + 1, 'a forced run lists again');
  db.close();
});

test('an empty member listing is an error, not a flat baseline', async () => {
  // Stamping the flag here would record "this server never gained a member" and
  // never try again.
  const guild = fakeGuild([]);
  const db = openDb(':memory:');
  const logger = silentLogger();

  await assert.rejects(() => backfillJoinHistory({ guild, db, logger }), /returned nothing/);
  assert.equal(db.getMeta('backfill.joinedAt.v1'), null);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM growth_backfill').c, 0);
  db.close();
});

test('a throttled first attempt is retried with backoff instead of being abandoned', async () => {
  const throttle = new Error('Request with opcode 8 was rate limited. Retry after 28.975 seconds.');
  const guild = fakeGuild(membersBackInTime(5, 1_700_000_000), { pageErrors: [throttle] });
  const db = openDb(':memory:');
  const logger = silentLogger();
  const slept = [];

  const result = await backfillJoinHistoryWithRetry({
    guild,
    db,
    logger,
    sleep: async (ms) => slept.push(ms),
  });

  assert.equal(result.ok, true);
  assert.equal(result.members, 5);
  assert.deepEqual(slept, [30_000], 'waits the first configured delay, then succeeds');
  assert.equal(db.getMeta('backfill.joinedAt.v1') !== null, true);
  db.close();
});

test('backfill gives up after the configured attempts and reports rather than throwing', async () => {
  const throttle = new Error('Request with opcode 8 was rate limited.');
  const guild = fakeGuild(membersBackInTime(5, 1_700_000_000), {
    pageErrors: [throttle, throttle, throttle],
  });
  const db = openDb(':memory:');
  const logger = silentLogger();
  const slept = [];

  const result = await backfillJoinHistoryWithRetry({
    guild,
    db,
    logger,
    sleep: async (ms) => slept.push(ms),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /rate limited/);
  assert.deepEqual(slept, [30_000, 120_000], 'two waits for three attempts');
  assert.equal(db.getMeta('backfill.joinedAt.v1'), null, 'flag stays unset so the next start retries');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM growth_backfill').c, 0);
  assert.ok(
    logger.seen.some((s) => s.level === 'warn' && /join-history backfill failed/.test(s.msg)),
    'the final failure is reported once, at warn level',
  );
  db.close();
});

test('backfill buckets joins by UTC day', async () => {
  const t = 1_700_000_000;
  const guild = fakeGuild([
    ['100000000000000001', { id: '1', joinedAt: new Date(t * 1000).toISOString(), user: { bot: false } }],
    ['100000000000000002', { id: '2', joinedAt: new Date((t + 60) * 1000).toISOString(), user: { bot: false } }],
    ['100000000000000003', { id: '3', joinedAt: new Date((t + DAY) * 1000).toISOString(), user: { bot: true } }],
  ]);
  const db = openDb(':memory:');

  await backfillJoinHistory({ guild, db, logger: silentLogger() });

  const rows = db.all('SELECT day_ts, joins FROM growth_backfill ORDER BY day_ts');
  assert.deepEqual(rows.map((r) => r.day_ts), [dayOf(t), dayOf(t + DAY)]);
  assert.deepEqual(rows.map((r) => r.joins), [2, 1]);
  assert.equal(String(db.getMeta('backfill.bots')), '1', 'meta is stored as text');
  db.close();
});
