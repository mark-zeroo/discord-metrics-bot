import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import * as Q from '../src/api/queries.js';
import { DAY, HOUR, dayOf, hourOf, isoDate } from '../src/time.js';
import { makeConfig } from './fixtures.mjs';

// Fixed Wednesday evening. Every date below is derived from it, so the weekday
// arithmetic in these tests does not depend on the day the suite runs.
const TS = Math.floor(Date.UTC(2026, 10, 11, 18, 0, 0) / 1000);
const day = (n) => dayOf(TS) - n * DAY;

/** The most recent Saturday on or before `fromTs`, at 00:00 UTC. */
function lastSaturday(fromTs) {
  let d = dayOf(fromTs);
  while (new Date(d * 1000).getUTCDay() !== 6) d -= DAY;
  return d;
}

const cfg = (env = {}) => makeConfig({ PER_MEMBER_COUNTERS: 'hmac', ...env });

function addTag(db, { name = 'Cup', start, end, kind = 'tournament' }) {
  db.run(
    `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
     VALUES(?,?,?,?,NULL,NULL,NULL,?)`,
    name, start, end, kind, TS,
  );
  return db.get('SELECT id FROM event_tag ORDER BY id DESC LIMIT 1').id;
}

/**
 * 28 baseline days where weekdays do 10 messages and Sat/Sun do 100. A weekend
 * event is ordinary here, and only a weekday-matched baseline says so.
 */
function weekdayShapedBaseline(db, endDay) {
  for (let i = 28; i >= 1; i -= 1) {
    const d = endDay - i * DAY;
    const dow = new Date(d * 1000).getUTCDay();
    const messages = dow === 0 || dow === 6 ? 100 : 10;
    db.run(
      'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
      d, 'c1', messages, 5,
    );
  }
}

const saturday = lastSaturday(TS);
const saturdayEnd = saturday + DAY;

test('weekday matching compares a weekend event against weekends, not the average day', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  addTag(db, { start: saturday, end: saturday + 12 * HOUR });

  // Twelve hours of the Saturday at 5 messages/hour = 60.
  for (let h = 0; h < 12; h += 1) {
    db.run(
      'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
      saturday + h * HOUR, 'c1', 5, 2,
    );
  }

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;

  // The trailing average across the whole baseline is far below a weekend day,
  // which is exactly the number that used to produce a fake uplift.
  assert.equal(tag.baseline.messages_per_day, 35.7);
  assert.equal(tag.baseline.matched.mean_messages_per_day, 35.7);
  assert.equal(tag.baseline.matched.days_used, 28);
  assert.equal(tag.baseline.matched.days_by_weekday.Sat, 4);
  assert.equal(tag.baseline.matched.messages_per_day_by_weekday.Sat, 100);

  // 12/24 of a Saturday, against 100/day per Saturday: 50 expected, 60 actual.
  assert.equal(tag.during.messages, 60);
  assert.equal(tag.uplift_status.messages.status, 'published');
  assert.equal(tag.uplift_status.messages.expected, 50);
  assert.equal(tag.uplift.messages, 1.2);
  // Voice and joins have no rows anywhere in this fixture, so they are refused for
  // lack of baseline activity rather than quietly reported as zero uplift.
  assert.deepEqual(tag.refusal_codes, ['no_baseline_activity']);
  assert.equal(tag.uplift_status.voice.code, 'no_baseline_activity');
});

test('a weekday event is compared against weekdays', () => {
  const db = openDb(':memory:');
  const monday = saturday + 2 * DAY;
  weekdayShapedBaseline(db, monday);
  addTag(db, { start: monday, end: monday + DAY });

  for (let h = 0; h < 24; h += 1) {
    db.run(
      'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
      monday + h * HOUR, 'c1', 2, 1,
    );
  }

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  // 48 messages against a 10/day Monday baseline: a 4.8x lift, and the trailing
  // average would have said 1.34x because of the weekends in it.
  assert.equal(tag.uplift.messages, 4.8);
  assert.ok(tag.uplift.messages > tag.during.messages / tag.baseline.messages_per_day);
});

test('two overlapping events refuse to attribute activity to either', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  addTag(db, { name: 'Cup A', start: saturday, end: saturday + 12 * HOUR });
  addTag(db, { name: 'Cup B', start: saturday + 6 * HOUR, end: saturday + 18 * HOUR });
  for (let h = 0; h < 12; h += 1) {
    db.run(
      'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
      saturday + h * HOUR, 'c1', 5, 2,
    );
  }

  const tags = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  for (const tag of tags) {
    assert.equal(tag.uplift, null);
    assert.ok(tag.refusal_codes.includes('overlapping_event'), tag.name);
    assert.equal(tag.overlapping_events.length, 1);
    // The measured activity is still reported: refusing the ratio is not refusing
    // to say what happened. The two windows overlap and see different totals.
    assert.equal(typeof tag.during.messages, 'number');
  }
});

test('a tiny event is measured but its ratio is refused', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  addTag(db, { start: saturday, end: saturday + 24 * HOUR });
  // 5 messages all day: a ratio here is noise with a decimal point.
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    saturday + 4 * HOUR, 'c1', 5, 1,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  assert.equal(tag.during.messages, 5);
  assert.equal(tag.uplift, null);
  assert.equal(tag.uplift_status.messages.code, 'insufficient_volume');
  assert.ok(tag.refusal_codes.includes('insufficient_volume'));
});

test('a partly observed short window refuses a per-day rate', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  addTag(db, { start: saturday + 8 * HOUR, end: saturday + 14 * HOUR });
  // Collection began two hours before the event ended, so most of it was never
  // observed: a rate over the observed sliver is not a rate for the event.
  db.setMeta('backfill.completed', new Date((saturday + 12 * HOUR) * 1000).toISOString());
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    saturday + 12 * HOUR, 'c1', 40, 3,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  assert.equal(tag.uplift, null);
  assert.equal(tag.uplift_status.messages.code, 'window_too_short');
  assert.equal(tag.during.messages, 40);
});

test('a baseline with too few days per weekday refuses instead of averaging two Saturdays', () => {
  const db = openDb(':memory:');
  // 10 baseline days, and the noisy-days floor relaxed so the weekday match is
  // what refuses rather than the overall length. The install date is what says
  // the other 18 days were not observed rather than silent.
  db.setMeta('backfill.completed', new Date((dayOf(saturday) - 10 * DAY) * 1000).toISOString());
  for (let i = 10; i >= 1; i -= 1) {
    db.run(
      'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
      dayOf(saturday) - i * DAY, 'c1', 50, 3,
    );
  }
  addTag(db, { start: saturday, end: saturdayEnd });
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    saturday + 2 * HOUR, 'c1', 60, 3,
  );

  const [tag] = Q.tags(db, cfg({ EVENT_BASELINE_NOISY_DAYS: '3', EVENT_MATCHED_MIN_DAYS: '3' }), {
    limit: 5,
    ts: TS,
  }).tags;
  assert.equal(tag.uplift, null);
  assert.equal(tag.uplift_status.messages.code, 'matched_baseline_thin');
  assert.match(tag.uplift_status.messages.detail, /Sat/);
});

test('a baseline that is too short overall refuses before matching even starts', () => {
  const db = openDb(':memory:');
  db.setMeta('backfill.completed', new Date((dayOf(saturday) - 7 * DAY) * 1000).toISOString());
  for (let i = 7; i >= 1; i -= 1) {
    db.run(
      'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
      dayOf(saturday) - i * DAY, 'c1', 50, 3,
    );
  }
  addTag(db, { start: saturday, end: saturdayEnd });
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    saturday + 2 * HOUR, 'c1', 60, 3,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  assert.equal(tag.uplift, null);
  assert.equal(tag.uplift_status.messages.code, 'baseline_too_short');
  assert.equal(tag.baseline.days_observed, 7);
});

test('a partial baseline day is excluded from the matched baseline', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  // Mark one baseline Saturday as partially observed: it is not a full day and
  // must not be averaged in as one.
  const partialSaturday = saturday - 7 * DAY;
  db.run('UPDATE message_day SET partial = 1 WHERE day_ts = ?', partialSaturday);
  addTag(db, { start: saturday, end: saturdayEnd });
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    saturday + 2 * HOUR, 'c1', 60, 3,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  assert.equal(tag.baseline.matched.days_by_weekday.Sat, 3);
  assert.equal(tag.baseline.matched.days_used, 27);
});

test('an upcoming event is refused with not_started and keeps its baseline', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  addTag(db, { start: dayOf(TS) + 4 * DAY, end: dayOf(TS) + 4 * DAY + 5 * HOUR });

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  assert.equal(tag.status, 'upcoming');
  assert.equal(tag.uplift, null);
  assert.equal(tag.uplift_status.messages.code, 'not_started');
  assert.equal(typeof tag.baseline.messages_per_day, 'number');
  // Its baseline window reaches four days into the future; those days have not
  // finished, so they are not baseline days at all.
  assert.equal(tag.baseline.matched.days_used, 20);
  assert.ok(tag.baseline.matched.mean_messages_per_day > 0);
});

test('a join-only event still gets a refusal for what cannot be measured', () => {
  const db = openDb(':memory:');
  const installed = dayOf(saturday) - 3 * DAY;
  db.setMeta('backfill.completed', new Date(installed * 1000).toISOString());
  addTag(db, { start: saturday, end: saturdayEnd });

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  // Only three baseline days exist, so the messages ratio is refused, but the
  // refusal says which condition failed rather than leaving a bare null.
  assert.equal(tag.uplift, null);
  assert.ok(tag.refusal_codes.length > 0);
  assert.equal(tag.uplift_status.messages.status, 'refused');
});

test('the matched baseline is absent rather than wrong when heartbeats are missing', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  addTag(db, { start: saturday, end: saturdayEnd });
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    saturday + 2 * HOUR, 'c1', 60, 3,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  assert.equal(tag.baseline.matched.heartbeats_available, false);
  assert.equal(tag.baseline.matched.days_used, 28, 'pre-heartbeat history still counts');
  assert.match(tag.baseline.matched.note, /inflate uplift/);
});
