import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { retention } from '../src/api/cohorts.js';
import { STATUS } from '../src/api/suppression.js';
import { DAY, HOUR, dayOf, isoDate, weekStart } from '../src/time.js';
import { makeConfig } from './fixtures.mjs';

// A fixed Wednesday evening, so nothing in this file depends on when it runs.
const TS = Math.floor(Date.UTC(2026, 10, 11, 18, 0, 0) / 1000);
const TODAY = dayOf(TS);
const day = (n) => TODAY - n * DAY;

const cfg = (env = {}) => makeConfig({ PER_MEMBER_COUNTERS: 'hmac', PRIVACY_MIN_CELL: '10', ...env });
const window365 = { label: '365d', seconds: 365 * DAY, all: false };

/** Heartbeats for a range of days: the collector was alive on each of them. */
function heartbeats(db, fromDay, toDay) {
  for (let d = fromDay; d <= toDay; d += DAY) {
    db.run(
      'INSERT INTO collector_day(day_ts, heartbeats, boots, first_ts, last_ts) VALUES(?,1,1,?,?)',
      d, d, d,
    );
  }
}

/**
 * A cohort of `size` members who all joined on `joinDay`, with `active` mapping a
 * day-offset to the member indexes that were active on that offset.
 */
function cohort(db, { prefix, joinDay, size, active = {}, joinedTs = null }) {
  for (let i = 0; i < size; i += 1) {
    const key = `${prefix}${String(i).padStart(2, '0')}`;
    db.run(
      'INSERT INTO member_tenure(user_hmac, joined_ts, left_ts, source, recorded_ts) VALUES(?,?,NULL,?,?)',
      key,
      joinedTs ?? joinDay + 12 * HOUR,
      'backfill',
      TS,
    );
  }
  for (const [offset, indexes] of Object.entries(active)) {
    for (const i of indexes) {
      db.run(
        'INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)',
        joinDay + Number(offset) * DAY,
        `${prefix}${String(i).padStart(2, '0')}`,
        3,
      );
    }
  }
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// ---------------------------------------------------------------- basic shape

test('retention measures D1 and D7 against each member join day', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(12), TODAY);
  // 40 members joined 10 days ago: 24 active the next day, 16 active on day 7.
  // Both figures and both complements are above the floor, which is what makes
  // them publishable at all.
  cohort(db, {
    prefix: 'a',
    joinDay: day(10),
    size: 40,
    active: { 1: range(0, 23), 7: range(0, 15) },
  });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1, 7, 30], ts: TS });

  assert.equal(out.available, true);
  assert.equal(out.cohorts.length, 1);
  const c = out.cohorts[0];
  assert.equal(c.starts, isoDate(day(10)));
  assert.equal(c.members.value, 40);

  assert.equal(c.d1.status, STATUS.published);
  assert.equal(c.d1.rate, 0.6);
  assert.equal(c.d1.retained, 24);
  assert.equal(c.d1.measured, 40);

  assert.equal(c.d7.rate, 0.4);
  assert.equal(c.d7.retained, 16);

  // Day 30 has not happened yet for this cohort. Null, and labelled immature —
  // a 0 here would be read as "nobody came back after a month".
  assert.equal(c.d30.rate, null);
  assert.equal(c.d30.status, STATUS.immature);
  assert.equal(c.d30.observed_day, isoDate(day(10) + 30 * DAY));
  assert.equal(c.d30.not_yet_due.value, 40);
  assert.equal(c.d30.not_observed.value, 0);
});

test('a young cohort is immature, not zero, for every period it cannot have reached', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(6), TODAY);
  cohort(db, { prefix: 'y', joinDay: day(4), size: 40, active: { 1: range(0, 19) } });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1, 7], ts: TS });
  const c = out.cohorts[0];
  assert.equal(c.d1.rate, 0.5);
  assert.equal(c.d7.status, STATUS.immature);
  assert.equal(c.d7.rate, null);
});

test('a day before per-member collection is unmeasured, not a retention failure', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(30), TODAY);
  // The day-grain only begins 5 days ago, with a single per-member row.
  db.run('INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)', day(5), 'first', 1);
  // This cohort joined 20 days ago, so its D1 day is 19 days ago: before the grain,
  // and no per-member activity exists from back then at all.
  cohort(db, { prefix: 'u', joinDay: day(20), size: 25, active: {} });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  const c = out.cohorts[0];
  assert.equal(c.d1.status, STATUS.unmeasured);
  assert.equal(c.d1.rate, null);
  assert.equal(c.d1.not_observed.value, 25);
  assert.equal(c.d1.not_yet_due.value, 0);
  assert.equal(c.d1.measured, null);
});

test('a day the collector was down is unmeasured rather than "nobody returned"', () => {
  const db = openDb(':memory:');
  // Heartbeats everywhere except the D1 observation day.
  heartbeats(db, day(12), day(11));
  heartbeats(db, day(9), TODAY);
  cohort(db, { prefix: 'd', joinDay: day(10), size: 20, active: {} });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  const c = out.cohorts[0];
  assert.equal(c.d1.status, STATUS.unmeasured);
  assert.equal(c.d1.not_observed.value, 20);
});

// ------------------------------------------------------------- suppression

test('a cohort below the anonymity floor is withheld, and stays visible as a row', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(12), TODAY);
  cohort(db, { prefix: 's', joinDay: day(10), size: 8, active: { 1: range(0, 4) } });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  assert.equal(out.cohorts.length, 1, 'the cohort row is not deleted, only withheld');
  const c = out.cohorts[0];
  assert.equal(c.members.value, null);
  assert.equal(c.members.status, STATUS.suppressed_small_count);
  assert.equal(c.suppressed_row, true);
  assert.equal(c.d1.status, STATUS.suppressed_small_count);
  assert.equal(c.d1.rate, null);
  assert.equal(out.suppression.suppressed_cells > 0, true);
});

test('a retention count whose complement is tiny is withheld as well', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(12), TODAY);
  // 38 of 40 came back on day 1: publishing 38 names the two who did not.
  cohort(db, { prefix: 'c', joinDay: day(10), size: 40, active: { 1: range(0, 37) } });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  const c = out.cohorts[0];
  assert.equal(c.members.value, 40, 'the cohort size itself is publishable');
  assert.equal(c.d1.retained, null);
  assert.equal(c.d1.rate, null);
  assert.equal(c.d1.status, STATUS.suppressed_small_count);
});

test('a pooled rate is withheld when any cohort feeding it is withheld', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(42), TODAY);
  // One publishable cohort, one below the floor.
  cohort(db, { prefix: 'p', joinDay: day(40), size: 30, active: { 1: range(0, 14) } });
  cohort(db, { prefix: 'q', joinDay: day(10), size: 6, active: { 1: range(0, 4) } });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  assert.equal(out.cohorts.length, 2);
  assert.equal(out.pooled.d1.status, STATUS.withheld_suppression);
  assert.equal(out.pooled.d1.rate, null);
  assert.equal(out.pooled.d1.retained, null);
});

test('a pooled rate publishes when every cohort publishes', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(42), TODAY);
  cohort(db, { prefix: 'p', joinDay: day(40), size: 40, active: { 1: range(0, 19) } });
  cohort(db, { prefix: 'q', joinDay: day(10), size: 20, active: { 1: range(0, 9) } });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  assert.equal(out.pooled.d1.status, STATUS.published);
  assert.equal(out.pooled.d1.retained, 30);
  assert.equal(out.pooled.d1.measured, 60);
  assert.equal(out.pooled.d1.rate, 0.5);
});

// --------------------------------------------------------------- edge cases

test('a rejoin is a new cohort and does not inherit the old membership activity', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(62), TODAY);
  // One person: joined 60 days ago, active on their D1, left 40 days ago, rejoined
  // 10 days ago and has done nothing since.
  db.run(
    'INSERT INTO member_tenure(user_hmac, joined_ts, left_ts, source, recorded_ts) VALUES(?,?,?,?,?)',
    'rejoiner', day(60) + 12 * HOUR, day(40), 'backfill', TS,
  );
  db.run(
    'INSERT INTO member_tenure(user_hmac, joined_ts, left_ts, source, recorded_ts) VALUES(?,?,?,?,?)',
    'rejoiner', day(10) + 12 * HOUR, null, 'live', TS,
  );
  // Activity on the old membership's D1 only.
  db.run('INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)', day(59), 'rejoiner', 5);
  // Filler members at both join dates, enough on the old day that its retained
  // count is publishable.
  cohort(db, { prefix: 'f', joinDay: day(60), size: 20, active: { 1: range(0, 19) } });
  cohort(db, { prefix: 'g', joinDay: day(10), size: 30, active: {} });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  const old = out.cohorts.find((c) => c.starts === isoDate(day(60)));
  const fresh = out.cohorts.find((c) => c.starts === isoDate(day(10)));

  assert.equal(old.members.value, 21);
  assert.equal(old.d1.retained, 21, 'the old membership was active on its own day 1');
  assert.equal(fresh.members.value, 31);
  assert.equal(fresh.d1.retained, 0, 'the rejoin must not borrow the old activity');
});

test('week cohorts bucket by Monday and say so', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(20), TODAY);
  cohort(db, { prefix: 'w', joinDay: day(14), size: 20, active: { 1: range(0, 9) } });

  const out = retention(db, cfg(), { window: window365, cohort: 'week', periods: [1], ts: TS });
  assert.equal(out.cohorts.length, 1);
  assert.equal(out.cohorts[0].starts, isoDate(weekStart(day(14))));
  assert.match(out.cohorts[0].cohort, /^week of /);
  assert.equal(out.basis.cohort_by, 'week');
});

test('a departed member stays in the denominator and is named separately', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(12), TODAY);
  cohort(db, { prefix: 'l', joinDay: day(10), size: 40, active: { 1: range(0, 29) } });
  // Five of the forty left before their D1 observation day, after posting.
  for (let i = 0; i < 5; i += 1) {
    db.run('UPDATE member_tenure SET left_ts = ? WHERE user_hmac = ?', day(10) + 18 * HOUR, `l${String(i).padStart(2, '0')}`);
  }

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  const c = out.cohorts[0];
  assert.equal(c.d1.measured, 40, 'they are still part of the cohort');
  // The five who left on their join day had no day 1 to be active on, and their
  // post-departure rows are not counted. They stay in the denominator as not
  // retained, and left_before_day says why.
  assert.equal(c.d1.retained, 25);
  // Five is below the floor, so the count is withheld; the boolean is what keeps the
  // rate from being read as pure disengagement.
  assert.equal(c.d1.left_before_day.value, null);
  assert.equal(c.d1.left_before_day.status, STATUS.suppressed_small_count);
  assert.equal(c.d1.left_before_day_any, true);
  assert.equal(c.d1.rate, 0.625);
});

test('the newest cohorts are kept when the list is capped, oldest first in the payload', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(60), TODAY);
  for (const n of [50, 40, 30, 20, 10]) cohort(db, { prefix: `k${n}`, joinDay: day(n), size: 12, active: {} });

  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], limit: 3, ts: TS });
  assert.equal(out.cohorts_total, 5);
  assert.equal(out.cohorts_truncated, true);
  assert.equal(out.capped_to_newest, 3);
  assert.deepEqual(
    out.cohorts.map((c) => c.starts),
    [isoDate(day(30)), isoDate(day(20)), isoDate(day(10))],
  );
});

test('counters off is unavailable, with a reason and a remedy', () => {
  const db = openDb(':memory:');
  const out = retention(db, makeConfig({ PER_MEMBER_COUNTERS: 'off' }), {
    window: window365,
    cohort: 'day',
    periods: [1],
    ts: TS,
  });
  assert.equal(out.available, false);
  assert.match(out.reason, /PER_MEMBER_COUNTERS/);
  assert.match(out.what_would_help, /hmac/);
  assert.equal(out.cohorts, undefined);
});

test('no collected spans reports no_data, not an empty server', () => {
  const db = openDb(':memory:');
  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  assert.equal(out.available, true);
  assert.deepEqual(out.cohorts, []);
  assert.equal(out.empty_reason.status, STATUS.no_data);
  assert.match(out.empty_reason.detail, /not "no members"/);
});

test('the payload never contains a pseudonym', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(12), TODAY);
  cohort(db, { prefix: 'leak', joinDay: day(10), size: 20, active: { 1: range(0, 9) } });

  const json = JSON.stringify(retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS }));
  assert.doesNotMatch(json, /leak00/);
  assert.doesNotMatch(json, /user_hmac/);
});

test('the status legend travels with the payload', () => {
  const db = openDb(':memory:');
  heartbeats(db, day(12), TODAY);
  cohort(db, { prefix: 'z', joinDay: day(10), size: 20, active: { 1: range(0, 9) } });
  const out = retention(db, cfg(), { window: window365, cohort: 'day', periods: [1], ts: TS });
  assert.equal(out.status_legend[STATUS.suppressed_small_count].startsWith('withheld:'), true);
  assert.match(out.suppression.policy, /below 10/);
  assert.equal(out.suppression.min_cell, 10);
});
