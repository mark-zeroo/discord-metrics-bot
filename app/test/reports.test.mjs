import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import * as Q from '../src/api/queries.js';
import { DAY, HOUR, dayOf, hourOf } from '../src/time.js';
import { makeConfig, seedConcentration } from './fixtures.mjs';

const GUILD = '1';

function cfg({ perMemberCounters = 'hmac', ...extra } = {}) {
  // Extra env keys pass straight through: the suppression floor is a real config
  // value and a test that needs a small one should set it, not bypass the guard.
  const env = { PER_MEMBER_COUNTERS: perMemberCounters, ...extra };
  if (extra.minCell !== undefined) {
    env.PRIVACY_MIN_CELL = String(extra.minCell);
    delete env.minCell;
  }
  return makeConfig(env);
}

const window30 = { label: '30d', seconds: 30 * DAY, all: false };

function message(userId, channelId, ts) {
  return {
    inGuild: () => true,
    guildId: GUILD,
    author: { id: userId, bot: false },
    member: { roles: { cache: new Map() } },
    channelId,
    system: false,
    createdTimestamp: ts * 1000,
  };
}

const now = () => Math.floor(Date.now() / 1000);

// --------------------------------------------------------------- exact posters

test('summary exposes an exact poster figure only inside hourly retention', () => {
  const db = openDb(':memory:');
  seedConcentration(db);

  const exact = Q.summary(db, cfg(), { window: window30 });
  assert.equal(exact.totals.unique_posters, 10);
  assert.equal(exact.totals.unique_posters_basis, 'exact');

  const capped = Q.summary(db, cfg(), { window: { label: 'all', seconds: null, all: true } });
  assert.equal(capped.totals.unique_posters, null);
  assert.equal(capped.totals.unique_posters_basis, 'unavailable');

  const off = Q.summary(db, cfg({ perMemberCounters: 'off' }), { window: window30 });
  assert.equal(off.totals.unique_posters, null);
});

test('summary flags a poster count that starts mid-window', () => {
  const db = openDb(':memory:');
  // Per-member counters were switched on recently: only the current hour exists,
  // so a 30-day "exact" count would really be the last hour's tail.
  const ts = hourOf(now());
  ['a', 'b', 'c'].forEach((m) => {
    db.run(
      'INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)',
      ts,
      m,
      5,
    );
  });

  const out = Q.summary(db, cfg(), { window: window30 });
  assert.equal(out.totals.unique_posters, 3);
  assert.equal(out.totals.unique_posters_basis, 'partial');
  assert.equal(out.totals.unique_posters_since, new Date(ts * 1000).toISOString().replace('.000Z', 'Z'));
  assert.ok(
    out.caveats.some((c) => /covers only from/.test(c)),
    'the floor is stated, not implied',
  );
});

test('activity marks exact posters null for buckets distinct counts cannot sum to', () => {
  const db = openDb(':memory:');
  const ts = now();

  for (let d = 0; d < 5; d += 1) {
    db.run(
      'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
      dayOf(ts) - d * DAY,
      'c1',
      50,
      9,
    );
    db.run('INSERT INTO poster_day(day_ts, posters) VALUES(?,?)', dayOf(ts) - d * DAY, 7);
  }

  const daily = Q.activity(db, cfg(), { window: window30, bucket: 'day', top: 3 });
  assert.equal(daily.series[0].unique_authors_exact, 7);

  const weekly = Q.activity(db, cfg(), { window: window30, bucket: 'week', top: 3 });
  assert.equal(weekly.series[0].unique_authors_exact, null);
});

// ------------------------------------------------- freshness and event state
// These three were found by running the API against a deployment that had just
// been installed: the payloads were technically correct and still told a
// misleading story, which is the failure mode this whole layer exists to avoid.

test('a window that predates the install says so instead of reporting zeros', () => {
  const db = openDb(':memory:');
  const ts = now();
  const startedAt = new Date((ts - 17 * 60) * 1000).toISOString();
  db.setMeta('boot.first', startedAt);
  db.setMeta('backfill.completed', startedAt);
  db.setMeta('backfill.joinedAt.v1', '1');

  const out = Q.summary(db, cfg(), { window: window30, ts });
  assert.equal(out.totals.messages, 0);
  assert.equal(out.totals.days_with_data, 0);
  // Empty dataset, not "counters are off" and not "past retention".
  assert.equal(out.totals.unique_posters_basis, 'unavailable');
  assert.equal(out.totals.unique_posters_reason, 'no_rows');

  const caveat = out.caveats[0];
  assert.match(caveat, /Collection began/);
  assert.match(caveat, /17 minutes/);
  assert.match(caveat, /30-day window/);
  assert.doesNotMatch(caveat, /0\.01 days/);
});

test('a fully covered window carries no freshness caveat', () => {
  const db = openDb(':memory:');
  const ts = now();
  const startedAt = new Date((ts - 200 * 24 * HOUR) * 1000).toISOString();
  db.setMeta('boot.first', startedAt);
  db.setMeta('backfill.completed', startedAt);
  db.setMeta('backfill.joinedAt.v1', '1');

  const out = Q.summary(db, cfg(), { window: window30, ts });
  assert.ok(!out.caveats.some((c) => c.includes('Collection began')));
});

test('the reason for a missing unique_posters distinguishes its three causes', () => {
  const db = openDb(':memory:');
  const ts = now();
  db.setMeta('backfill.completed', new Date((ts - 200 * 24 * HOUR) * 1000).toISOString());

  const disabled = Q.summary(db, cfg({ perMemberCounters: 'off' }), { window: window30, ts });
  assert.equal(disabled.totals.unique_posters_reason, 'counters_disabled');
  assert.match(disabled.caveats.join(' '), /PER_MEMBER_COUNTERS=hmac, which is off here/);

  const old = Q.summary(db, cfg(), { window: { label: 'all', seconds: null, all: true }, ts });
  assert.equal(old.totals.unique_posters_reason, 'beyond_retention');
  assert.match(old.caveats.join(' '), /hourly retention/);
});

test('guild event status is decoded, not passed through as a raw enum', () => {
  const db = openDb(':memory:');
  const ts = now();
  // The collector writes this column as TEXT, so it arrives as "2.0".
  db.run(
    `INSERT INTO guild_event (event_id, name, start_ts, end_ts, user_count, status, observed_ts)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    'e1',
    'Tournament',
    ts - HOUR,
    ts + HOUR,
    '2.0',
    ts,
  );

  const out = Q.events(db, cfg(), { ts });
  assert.equal(out.events[0].status, 'active');

  db.run('UPDATE guild_event SET status = ? WHERE event_id = ?', 'not-a-number', 'e1');
  assert.equal(Q.events(db, cfg(), { ts }).events[0].status, 'unknown');
});

test('growth omits members where it is unknown instead of padding with nulls', () => {
  const db = openDb(':memory:');
  const ts = now();
  const day = dayOf(ts - 2 * DAY);
  db.run(
    'INSERT INTO growth_day (day_ts, joins, leaves, members, partial) VALUES (?, ?, ?, NULL, 0)',
    day,
    3,
    0,
  );

  const out = Q.growth(db, cfg(), { window: window30, bucket: 'day', ts });
  const point = out.series.find((p) => p.joins === 3);
  assert.ok(point, 'join bucket present');
  assert.ok(!('members' in point), 'members key omitted when unknown');
  assert.equal(point.joins, 3);
});

test('summary and growth agree on joins when the history is only backfilled', () => {
  const db = openDb(':memory:');
  const ts = now();
  // Three days of joined_at backfill, nothing measured yet: the state of a real
  // deployment in its first hours, where summary said 0 and growth said 7.
  for (const offset of [3, 9, 20]) {
    db.run(
      'INSERT INTO growth_backfill (day_ts, joins) VALUES (?, ?)',
      dayOf(ts - offset * DAY),
      7,
    );
  }

  const summary = Q.summary(db, cfg(), { window: window30, ts });
  const growth = Q.growth(db, cfg(), { window: window30, bucket: 'day', ts });

  assert.equal(summary.totals.joins, 21);
  assert.equal(summary.totals.joins, growth.totals.joins, 'endpoints must not disagree');
  assert.equal(summary.totals.backfilled_joins, 21);
  assert.equal(summary.totals.leaves, 0);
});

test('the freshness caveat exempts joins, which do have history', () => {
  const db = openDb(':memory:');
  const ts = now();
  const startedAt = new Date((ts - 30 * 60) * 1000).toISOString();
  db.setMeta('boot.first', startedAt);
  db.setMeta('backfill.completed', startedAt);
  db.run('INSERT INTO growth_backfill (day_ts, joins) VALUES (?, ?)', dayOf(ts - 5 * DAY), 12);

  const out = Q.summary(db, cfg(), { window: window30, ts });
  assert.match(out.caveats[0], /Joins are the exception/);
  assert.equal(out.totals.joins, 12);
  // days_with_data counts observed days, and backfilled joins are not observed days.
  assert.equal(out.totals.days_with_data, 0);
});

test('days_with_data counts voice-only days, not just message days', () => {
  const db = openDb(':memory:');
  const ts = now();
  db.run(
    'INSERT INTO voice_day (day_ts, channel_id, seconds, partial) VALUES (?, ?, ?, 0)',
    dayOf(ts - DAY),
    'vc1',
    3600,
  );
  db.run(
    'INSERT INTO voice_day (day_ts, channel_id, seconds, partial) VALUES (?, ?, ?, 0)',
    dayOf(ts - 2 * DAY),
    'vc2',
    1800,
  );

  const out = Q.summary(db, cfg(), { window: window30, ts });
  assert.equal(out.totals.messages, 0);
  assert.equal(out.totals.days_with_data, 2);
});

// ------------------------------------------------- tags against a short history
// A tournament is usually tagged from its first match to its final, and the bot
// is often installed in the middle of one - or after it is over. Both cases used
// to divide real activity by days that could not have produced any.

test('quality reports whether the per-member daily grain is filling', () => {
  const db = openDb(':memory:');
  const ts = hourOf(now());
  db.run('INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)', dayOf(ts), 'a', 3);
  db.run('INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)', dayOf(ts) - 86400, 'b', 1);
  db.run(
    'INSERT INTO member_tenure(user_hmac, joined_ts, left_ts, source, recorded_ts) VALUES(?,?,NULL,?,?)',
    'a', dayOf(ts) - 10 * 86400, 'backfill', ts,
  );

  db.run('INSERT INTO collector_day(day_ts, heartbeats, boots, first_ts, last_ts) VALUES(?,1,1,?,?)', dayOf(ts), ts, ts);

  const out = Q.qualityReport(db, cfg(), { ts });
  assert.equal(out.collector_days.heartbeat_since, new Date(dayOf(ts) * 1000).toISOString().slice(0, 10));
  assert.match(out.collector_days.note, /Heartbeats begin/);
  assert.match(out.collector_days.note, /unknown, not unobserved/);
  assert.equal(out.privacy.per_member_rows.member_day.rows, 2);
  assert.equal(out.privacy.per_member_rows.member_day.days, 2);
  assert.equal(out.privacy.per_member_rows.member_day.first_day, new Date((dayOf(ts) - 86400) * 1000).toISOString().slice(0, 10));
  assert.equal(out.privacy.per_member_rows.member_tenure.spans, 1);
  assert.equal(out.privacy.per_member_rows.member_tenure.open_spans, 1);
});
