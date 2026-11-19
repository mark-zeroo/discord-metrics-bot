import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { coreConcentration, lastCompletePeriodStart } from '../src/api/core.js';
import { STATUS } from '../src/api/suppression.js';
import { DAY, HOUR, isoDate, weekStart } from '../src/time.js';
import { makeConfig } from './fixtures.mjs';

// Fixed Wednesday evening; the complete weeks are the ones before it.
const TS = Math.floor(Date.UTC(2026, 10, 11, 18, 0, 0) / 1000);
const THIS_WEEK = weekStart(TS);
const week = (n) => THIS_WEEK - n * 7 * DAY; // week(1) is the last complete week
const window90 = { label: '90d', seconds: 90 * DAY, all: false };

const cfg = (env = {}) => makeConfig({ PER_MEMBER_COUNTERS: 'hmac', PRIVACY_MIN_CELL: '10', ...env });

/** A member with `messages` on the Monday of the given week. */
function active(db, key, weekStartTs, messages) {
  db.run(
    'INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)',
    weekStartTs,
    key,
    messages,
  );
}

function tenure(db, key, joinedTs, leftTs = null) {
  db.run(
    'INSERT INTO member_tenure(user_hmac, joined_ts, left_ts, source, recorded_ts) VALUES(?,?,?,?,?)',
    key,
    joinedTs,
    leftTs,
    'backfill',
    TS,
  );
}

/** `count` members posting `messages` in the given week. */
function block(db, prefix, count, weekStartTs, messages, pad = 2) {
  for (let i = 0; i < count; i += 1) active(db, `${prefix}${String(i).padStart(pad, '0')}`, weekStartTs, messages);
}

test('periods are complete weeks, and the current week is excluded', () => {
  const db = openDb(':memory:');
  // 100 active in the last complete week, and a huge spike in the week that is
  // still running: including it would read as a collapse next Monday.
  block(db, 'a', 100, week(1), 10);
  block(db, 'b', 100, THIS_WEEK, 500);

  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  assert.equal(out.available, true);
  assert.equal(out.periods.length, 1);
  assert.equal(out.periods[0].starts, isoDate(week(1)));
  assert.equal(out.periods[0].active_members.value, 100);
});

test('core is the top share of active members and concentration is reported', () => {
  const db = openDb(':memory:');
  // 100 active: 20 core posters at 50 messages, 80 at 2. Core = 20% of 100.
  block(db, 'c', 20, week(1), 50);
  block(db, 'o', 80, week(1), 2);

  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  const p = out.periods[0];
  assert.equal(p.status, STATUS.published);
  assert.equal(p.active_members.value, 100);
  assert.equal(p.core_size.value, 20);
  assert.equal(p.concentration.share_of_messages_from_core, 0.862); // 1000 of 1160
  assert.equal(p.concentration.gini > 0, true);
  // 19 people produce over 80% of the messages: that count names a group of 19,
  // which is publishable, and the top-10% share is a shape, not a person.
  assert.equal(p.concentration.members_for_80_percent_of_messages.value, 19);
});

test('a period nobody posted in is a measured zero, not a withheld one', () => {
  const db = openDb(':memory:');
  block(db, 'c', 20, week(3), 50);
  // week(2) and week(1) are empty: the collector was running, nobody posted.
  for (let d = 1; d <= 21; d += 1) {
    db.run('INSERT INTO collector_day(day_ts, heartbeats, boots, first_ts, last_ts) VALUES(?,1,1,?,?)', week(2) + d * DAY, 0, 0);
  }

  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  const empty = out.periods.find((p) => p.starts === isoDate(week(1)));
  assert.equal(empty.active_members.value, 0);
  assert.equal(empty.core_size.value, 0);
  assert.equal(empty.status, STATUS.no_data);
  assert.equal(empty.concentration, undefined);
  assert.match(empty.reason, /measured zero/);
});

test('a period with fewer than k active members is withheld entirely', () => {
  const db = openDb(':memory:');
  block(db, 't', 8, week(1), 30);

  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  const p = out.periods[0];
  assert.equal(p.status, STATUS.suppressed_small_count);
  assert.equal(p.active_members.value, null);
  assert.equal(p.core_size.value, null);
  assert.equal(p.concentration, undefined);
  assert.match(p.reason, /below the anonymity floor/);
  assert.match(p.reason, /not a community/);
});

test('the reason names the cell that was too small, not a blanket floor', () => {
  const db = openDb(':memory:');
  // 25 active, core of 5: the period is withheld because the *core* is too small,
  // and saying "fewer than 10 active members" next to active_members: 25 would
  // contradict the same payload.
  block(db, 'c', 25, week(1), 30);

  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  const p = out.periods[0];
  assert.equal(p.active_members.value, 25);
  assert.equal(p.core_size.status, STATUS.suppressed_small_count);
  assert.equal(p.status, STATUS.suppressed_small_count);
  assert.match(p.reason, /core is 5 of 25 active members/);
  assert.doesNotMatch(p.reason, /fewer than 10 active members/);
});

test('the distribution bands use complementary suppression', () => {
  const db = openDb(':memory:');
  // 100 active: 20 at 50 messages, 80 at 2 -> bands 10-49: 0, 50-199: 20,
  // 1-9: 80. All three publish on their own, so no secondary suppression is due.
  block(db, 'c', 20, week(1), 50);
  block(db, 'o', 80, week(1), 2);

  let p = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS }).periods[0];
  let bands = Object.fromEntries(p.concentration.distribution.map((b) => [b.band, b.members]));
  assert.equal(bands['1-9'].value, 80);
  assert.equal(bands['50-199'].value, 20);
  assert.equal(p.concentration.distribution.length, 5);

  // Now a partition with exactly one small band: 200 in 200-999, 50 in 10-49, 7 in
  // 1-9. The 7 is withheld, and 257 - 250 puts it straight back on the page, so
  // the smallest published band goes too.
  const db2 = openDb(':memory:');
  block(db2, 'big', 200, week(1), 250); // band 200-999
  block(db2, 'mid', 50, week(1), 20); // band 10-49
  block(db2, 'small', 7, week(1), 5); // band 1-9: below floor
  p = coreConcentration(db2, cfg(), { window: window90, bucket: 'week', ts: TS }).periods[0];
  bands = Object.fromEntries(p.concentration.distribution.map((b) => [b.band, b.members]));
  assert.equal(bands['1-9'].status, STATUS.suppressed_small_count);
  assert.equal(bands['10-49'].status, STATUS.suppressed_complementary);
  assert.equal(bands['10-49'].value, null);
  assert.equal(bands['200-999'].value, 200, 'the large band is still published');
  const bigBand = p.concentration.distribution.find((b) => b.band === '200-999');
  assert.equal(bigBand.members.count, 200, 'the count is kept as context');
});

test('core churn separates stayed, slipped, quiet and departed', () => {
  const db = openDb(':memory:');
  const joined = week(8);
  // Previous week: 100 active, core of 20 at 50 messages each.
  block(db, 'c', 20, week(2), 50);
  block(db, 'o', 80, week(2), 2);
  for (let i = 0; i < 20; i += 1) tenure(db, `c${String(i).padStart(2, '0')}`, joined);
  for (let i = 0; i < 80; i += 1) tenure(db, `o${String(i).padStart(2, '0')}`, joined);

  // This week: 10 of the core stay, 5 slip to 1 message, 3 go quiet, 2 leave;
  // 5 new high posters arrive and 5 ordinary members take the remaining core seats
  // because they now out-post the quiet ones.
  block(db, 'c', 10, week(1), 50);
  for (let i = 10; i < 15; i += 1) active(db, `c${String(i).padStart(2, '0')}`, week(1), 1);
  for (let i = 17; i < 20; i += 1) {
    db.run(
      'UPDATE member_tenure SET left_ts = ? WHERE user_hmac = ?',
      week(1) + 2 * DAY,
      `c${String(i).padStart(2, '0')}`,
    );
  }
  block(db, 'p', 5, week(1), 60);
  block(db, 'o', 80, week(1), 2);

  // k=2 here so every cell in the transition is above the floor and the arithmetic
  // can be asserted directly. The default floor's effect is pinned by the next test.
  const out = coreConcentration(db, cfg({ PRIVACY_MIN_CELL: '2' }), {
    window: window90,
    bucket: 'week',
    ts: TS,
  });
  const t = out.transitions[0];
  assert.equal(out.transitions.length, 1);
  assert.equal(t.core_previous.value, 20);
  assert.equal(t.stayed_core.value, 10);
  assert.equal(t.left_core_active.value, 5);
  assert.equal(t.left_core_gone.value, 5);
  assert.equal(t.left_core_inactive.value, 2, 'gone minus the three confirmed departures');
  assert.equal(t.left_server_confirmed.value, 3);
  assert.equal(t.core_retention_rate.value, 0.5);
  assert.equal(t.core_dropout_rate.value, 0.25);
  assert.match(t.note, /fixed fraction/);
});

test('a small churn cell is withheld rather than published or zeroed', () => {
  const db = openDb(':memory:');
  block(db, 'c', 20, week(2), 50);
  block(db, 'o', 80, week(2), 2);
  block(db, 'c', 10, week(1), 50);
  for (let i = 10; i < 15; i += 1) active(db, `c${String(i).padStart(2, '0')}`, week(1), 1);
  block(db, 'p', 5, week(1), 60);
  block(db, 'o', 80, week(1), 2);

  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  const t = out.transitions[0];
  assert.equal(t.stayed_core.value, 10);
  assert.equal(t.left_core_active.value, null);
  assert.equal(t.left_core_active.status, STATUS.suppressed_small_count);
  // Dropout is derived from the gone count, which is also below the floor.
  assert.equal(t.core_dropout_rate.value, null);
  assert.equal(t.core_retention_rate.value, 0.5, 'retention still publishes on its own cells');
});

test('a trend needs enough published periods and refuses to invent one', () => {
  const db = openDb(':memory:');
  block(db, 'c', 20, week(2), 50);
  block(db, 'o', 80, week(2), 2);
  block(db, 'c', 20, week(1), 50);
  block(db, 'o', 80, week(1), 2);

  const two = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  assert.equal(two.trend.status, STATUS.unmeasured);
  assert.equal(two.trend.periods_published, 2);
  assert.equal(two.trend.periods_needed, 4);
  assert.match(two.trend.detail, /two points/);
});

test('trend direction comes from first half versus second half', () => {
  const db = openDb(':memory:');
  for (let w = 5; w >= 1; w -= 1) {
    const top = 30 + (5 - w) * 60;
    active(db, 'top', week(w), top);
    block(db, `w${w}`, 99, week(w), 5);
  }

  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  assert.equal(out.trend.status, STATUS.published);
  assert.equal(out.trend.periods_compared, 5);
  assert.equal(out.trend.gini.direction, 'more_concentrated');
  assert.equal(out.trend.top_10_percent_share.direction, 'more_concentrated');
  assert.match(out.trend.note, /not that volume grew/);
});

test('share changes the size of the core', () => {
  const db = openDb(':memory:');
  block(db, 'c', 20, week(1), 50);
  block(db, 'o', 80, week(1), 2);

  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', share: 0.3, ts: TS });
  assert.equal(out.periods[0].core_size.value, 30);
  assert.equal(out.periods[0].core_share_used, 0.3);
});

test('counters off is unavailable, with a reason', () => {
  const db = openDb(':memory:');
  const out = coreConcentration(db, makeConfig({ PER_MEMBER_COUNTERS: 'off' }), {
    window: window90,
    bucket: 'week',
    ts: TS,
  });
  assert.equal(out.available, false);
  assert.match(out.reason, /PER_MEMBER_COUNTERS/);
});

test('no per-member rows reports no_data rather than an empty core', () => {
  const db = openDb(':memory:');
  const out = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  assert.equal(out.available, true);
  assert.deepEqual(out.periods, []);
  assert.equal(out.trend.status, STATUS.no_data);
});

test('lastCompletePeriodStart never returns the period containing now', () => {
  assert.equal(lastCompletePeriodStart(TS, 'week'), weekStart(TS) - 7 * DAY);
  assert.equal(lastCompletePeriodStart(TS, 'day'), Math.floor(TS / DAY) * DAY - DAY);
  // A month boundary: the current month is never "complete".
  const firstOfMonth = Math.floor(Date.UTC(2026, 10, 1) / 1000);
  assert.ok(lastCompletePeriodStart(firstOfMonth + HOUR, 'month') < firstOfMonth);
});

test('an empty period list says whether to wait or to widen the window', () => {
  const db = openDb(':memory:');
  // Per-member data begins on this (still running) week's Monday, so the only
  // complete week predates it.
  const grainStart = week(0);
  db.run('INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)', grainStart, 'u1', 5);

  const waiting = coreConcentration(db, cfg(), { window: window90, bucket: 'week', ts: TS });
  assert.deepEqual(waiting.periods, []);
  assert.equal(waiting.trend.status, STATUS.immature);
  assert.match(waiting.trend.detail, /first complete period with per-member data is week of/);
  // The first measurable period starts next week and only completes the week after.
  assert.equal(waiting.trend.measurable_from, isoDate(week(0) + 14 * DAY));
  assert.doesNotMatch(waiting.trend.detail, /No complete period falls inside this window/);

  // A window too short to contain one complete week is the other case entirely.
  const narrow = coreConcentration(db, cfg(), {
    window: { label: '1d', seconds: DAY },
    bucket: 'week',
    ts: TS,
  });
  assert.equal(narrow.trend.status, STATUS.unmeasured);
  assert.match(narrow.trend.detail, /shorter than one complete week/);
});
