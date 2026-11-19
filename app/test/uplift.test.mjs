import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import * as Q from '../src/api/queries.js';
import { DAY, HOUR, dayOf, hourOf, iso, isoDate } from '../src/time.js';
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

// ------------------------------------------------- nesting, refusals, coverage

test('a nested tag does not block, a partial overlap does', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  // Umbrella: the whole weekend. Child: Saturday afternoon, entirely inside it.
  const umbrella = addTag(db, { name: 'Umbrella', start: saturday, end: saturday + DAY });
  addTag(db, { name: 'Child', start: saturday + 8 * HOUR, end: saturday + 16 * HOUR });
  for (let h = 8; h < 16; h += 1) {
    db.run(
      'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
      saturday + h * HOUR, 'c1', 5, 2,
    );
  }

  const tags = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  const byName = Object.fromEntries(tags.map((t) => [t.name, t]));

  assert.equal(byName.Child.overlapping_events.length, 0, 'containment is not a conflict');
  assert.deepEqual(byName.Child.nested_events.map((e) => e.id), [umbrella]);
  assert.equal(byName.Child.nested_events[0].relation, 'encloses_this_event');
  assert.equal(byName.Child.uplift_status.messages.status, 'published');

  assert.equal(byName.Umbrella.nested_events[0].relation, 'inside_this_event');
  assert.equal(byName.Umbrella.overlapping_events.length, 0);

  // A partial overlap — each window reaching outside the other — still refuses.
  const db2 = openDb(':memory:');
  weekdayShapedBaseline(db2, dayOf(saturday));
  addTag(db2, { name: 'A', start: saturday, end: saturday + 20 * HOUR });
  addTag(db2, { name: 'B', start: saturday + 12 * HOUR, end: saturday + 30 * HOUR });
  const tags2 = Q.tags(db2, cfg(), { limit: 5, ts: TS }).tags;
  for (const t of tags2) {
    assert.ok(t.refusal_codes.includes('overlapping_event'), t.name);
    assert.equal(t.overlapping_events.length, 1);
    assert.equal(t.nested_events.length, 0);
  }
});

test('every refusal carries its metric, detail and remedy', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  addTag(db, { start: dayOf(TS) + 4 * DAY, end: dayOf(TS) + 4 * DAY + 6 * HOUR });

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  assert.equal(tag.refusal_codes.length, 1);
  assert.equal(tag.refusals.length, 3, 'one entry per metric, matching uplift_status');
  const messages = tag.refusals.find((r) => r.metric === 'messages');
  assert.equal(messages.code, 'not_started');
  assert.match(messages.detail, /has not started/);
  assert.match(messages.remedy, /once the window has opened/);
  // The old payload carried refusals: [] beside a non-empty refusal_codes.
  assert.deepEqual(
    tag.refusals.map((r) => r.metric).sort(),
    Object.keys(tag.uplift_status).sort(),
  );
});

test('a baseline mixing pre-heartbeat and heartbeat days uses each day on its own terms', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  // Heartbeats start 5 days before the event: the earlier baseline days have rows
  // but no heartbeat, and must still count through the activity fallback.
  for (let d = 1; d <= 5; d += 1) {
    db.run('INSERT INTO collector_day(day_ts, heartbeats, boots, first_ts, last_ts) VALUES(?,1,1,0,0)', saturday - d * DAY);
  }
  addTag(db, { start: saturday, end: saturday + 24 * HOUR });
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    saturday + 2 * HOUR, 'c1', 60, 3,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  assert.equal(tag.baseline.matched.days_used, 28, 'pre-heartbeat days still count');
  assert.equal(tag.baseline.matched.heartbeats_available, true);
  assert.equal(tag.baseline.matched.heartbeat_from, `${isoDate(saturday - 5 * DAY)}T00:00:00Z`.slice(0, 10));
  assert.equal(tag.uplift_status.messages.status, 'published');
});

test('the trailing average and the matched baseline agree on a weekday-shaped window', () => {
  const db = openDb(':memory:');
  weekdayShapedBaseline(db, dayOf(saturday));
  addTag(db, { start: saturday, end: saturday + 24 * HOUR });
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    saturday + 2 * HOUR, 'c1', 60, 3,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts: TS }).tags;
  // Same day set, so the overall mean must equal the sum over weekdays divided by
  // 7: (5*10 + 2*100) / 7 = 35.7. They used to disagree because the trailing rate
  // divided by a fractional coverage span instead of the days it summed.
  assert.equal(tag.baseline.messages_per_day, 35.7);
  const fromWeekdays = tag.baseline.matched.messages_per_day_by_weekday;
  const mean = Object.values(fromWeekdays).reduce((a, b) => a + b, 0) / 7;
  assert.equal(Number(mean.toFixed(1)), 35.7);
});

/* ------------------------------------------------------------------ *
 * end-to-end tag payloads on now-relative fixtures
 *
 * These exercise /v1/tags through its whole shape — notes and their caps, joins
 * basis, partial windows, ordering — rather than the weekday-matching arithmetic
 * above. They live here rather than in their own file because both halves
 * describe one endpoint, and a second copy of the tag fixtures is how test
 * suites rot.
 * ------------------------------------------------------------------ */

const GUILD = '1';

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

function tagFixture({ installedDaysAgo }) {
  const db = openDb(':memory:');
  const ts = now();
  const installed = ts - installedDaysAgo * DAY;
  db.setMeta('boot.first', new Date(installed * 1000).toISOString());
  db.setMeta('backfill.completed', new Date(installed * 1000).toISOString());
  const addTag = (name, start, end, extra = {}) =>
    db.run(
      `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
       VALUES(?,?,?,?,?,?,?,?)`,
      name, start, end, extra.kind ?? 'tournament', extra.prize ?? null,
      extra.participants ?? null, extra.notes ?? null, ts,
    );
  return { db, ts, installed, addTag };
}

test('tag impact compares the window against the trailing baseline window', () => {
  const db = openDb(':memory:');
  const ts = now();
  const start = ts - 4 * HOUR;
  const end = ts - 1 * HOUR;

  db.run(
    `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
     VALUES(?,?,?,?,?,?,?,?)`,
    'Spring 5v5 Tourney', start, end, 'tournament', '6000 tokens', 30, null, ts,
  );

  // 28 baseline days at 100 messages/day = 2800, i.e. 100/day.
  //
  // Anchored to the baseline's own end, not to today. The baseline window ends at
  // dayOf(start), and start is four hours back, so late in the UTC evening the
  // two differ: inserting days relative to dayOf(ts) put one row past the window
  // and the test reported 27 observed days. Same intent, no clock dependency.
  const baseEnd = dayOf(ts - 4 * HOUR);
  for (let d = 28; d >= 1; d -= 1) {
    db.run(
      'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
      baseEnd - d * DAY,
      'c1',
      100,
      20,
    );
  }
  // Three hours of the tag at 10x the hourly baseline (100/24 ≈ 4.2/h → 42/h).
  for (let h = 1; h <= 3; h += 1) {
    db.run(
      'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
      hourOf(ts) - h * HOUR,
      'c1',
      42,
      8,
    );
  }

  const out = Q.tags(db, cfg(), { limit: 5, ts });

  assert.equal(out.count, 1);
  const tag = out.tags[0];
  assert.equal(tag.name, 'Spring 5v5 Tourney');
  assert.equal(tag.duration_hours, 3);
  assert.equal(tag.granularity, 'hour');
  assert.equal(tag.during.messages, 126);
  assert.equal(tag.baseline.window_days, 28);
  assert.equal(tag.baseline.days_observed, 28);
  assert.equal(tag.baseline.coverage_span_days, 28);
  assert.equal(tag.baseline.messages_per_day, 100);
  // 42/hour works out to ~1008/day against a 100/day baseline.
  assert.equal(tag.uplift.messages, 10.08);
});

test('a tag whose window has not opened is upcoming, not ongoing', () => {
  // An event tagged for next week used to come back ongoing: true, which reads as
  // "the tournament is happening and nobody showed up".
  const db = openDb(':memory:');
  const ts = now();
  const start = dayOf(ts) + 4 * DAY;
  const end = start + 5 * HOUR;

  db.run(
    `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
     VALUES(?,?,?,?,?,?,?,?)`,
    'Next week cup', start, end, 'tournament', null, null, null, ts,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.status, 'upcoming');
  assert.equal(tag.ongoing, false);
  // Zeros are not the same statement as "not measured yet": a model reads
  // "0 messages, uplift 0" as a failed event, so an unstarted tag reports nulls.
  assert.equal(tag.during, null);
  assert.equal(tag.uplift, null);
  assert.match(tag.note, /has not started/);
  // The baseline block is still there (it is what the event will be compared to),
  // but on a database with no rows and no heartbeats it reports days_used: 0 and a
  // null rate rather than "0.0 messages/day", which would be a measurement claim
  // about a window nothing ever watched.
  assert.equal(tag.baseline.matched.days_used, 0);
  assert.equal(tag.baseline.messages_per_day, null);
});

test('a tag inside its window is ongoing, and a finished one is past', () => {
  const db = openDb(':memory:');
  const ts = now();

  const insert = (name, start, end) =>
    db.run(
      `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
       VALUES(?,?,?,?,?,?,?,?)`,
      name, start, end, null, null, null, null, ts,
    );

  insert('Now', ts - HOUR, ts + HOUR);
  insert('Done', ts - 4 * HOUR, ts - 2 * HOUR);

  const out = Q.tags(db, cfg(), { limit: 5, ts });
  const byName = new Map(out.tags.map((t) => [t.name, t]));
  assert.equal(byName.get('Now').status, 'ongoing');
  assert.equal(byName.get('Now').ongoing, true);
  assert.equal(byName.get('Done').status, 'past');
  assert.equal(byName.get('Done').ongoing, false);
});

test('tag impact falls back to daily rows once hourly rows are pruned', () => {
  const db = openDb(':memory:');
  const ts = now();
  const start = dayOf(ts) - 400 * DAY;
  const end = start + DAY;

  db.run(
    `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
     VALUES(?,?,?,?,?,?,?,?)`,
    'Old game night', start, end, null, null, null, null, ts,
  );
  db.run(
    'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
    start,
    'c1',
    250,
    15,
  );

  const out = Q.tags(db, cfg(), { limit: 5, ts });
  assert.equal(out.tags[0].granularity, 'day');
  assert.equal(out.tags[0].during.messages, 250);
});

test('tags on an empty database return an empty list, not an error', () => {
  const db = openDb(':memory:');
  const out = Q.tags(db, cfg(), { limit: 5 });
  assert.equal(out.count, 0);
  assert.deepEqual(out.tags, []);
});

// ------------------------------------------------------------------ summary

test('a tournament that began before install reports rates over the observed span', () => {
  const { db, ts, installed, addTag } = tagFixture({ installedDaysAgo: 1 });
  // Six-day window, matches on three of those days, but only the last day is
  // observable: 1800 messages in that day.
  addTag('Long cup', ts - 5 * DAY, ts + DAY);
  for (let hour = 0; hour < 24; hour += 2) {
    db.run(
      'INSERT INTO message_hour (hour_ts, channel_id, messages) VALUES (?, ?, ?)',
      installed + hour * HOUR,
      'c1',
      150,
    );
  }

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.status, 'ongoing');
  assert.equal(tag.during.messages, 1800);
  // 1800 over ~1 observed day, not over the 6-day window (which would say 300).
  assert.equal(tag.during.messages_per_day, 1800);
  assert.equal(tag.during.observed.complete, false);
  assert.match(tag.during.observed.from, /T/);
  assert.match(tag.note, /Coverage: .* of the .* hours this event has run so far/);
});

test('a tournament that ended before install still reports joins, but no activity', () => {
  const { db, ts, addTag } = tagFixture({ installedDaysAgo: 1 });
  addTag('Old cup', ts - 10 * DAY, ts - 5 * DAY);
  // Current members who joined during the old tournament.
  db.run('INSERT INTO growth_backfill (day_ts, joins) VALUES (?, ?)', dayOf(ts - 7 * DAY), 9);

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.during.messages, null, 'no messages were ever counted for that window');
  assert.equal(tag.during.messages_per_day, null);
  assert.equal(tag.during.voice_hours, null);
  assert.equal(tag.during.joins, 9, 'join dates do reach back before install');
  assert.equal(tag.during.joins_basis, 'backfill');
  assert.equal(tag.during.observed, null);
  assert.equal(tag.uplift, null);
  assert.match(tag.note, /ended before collection began/);
});

test('uplift is null, not zero, when there is no baseline data at all', () => {
  const { db, ts, addTag } = tagFixture({ installedDaysAgo: 1 });
  addTag('Cup today', ts - 2 * HOUR, ts + 4 * HOUR);
  db.run(
    'INSERT INTO message_hour (hour_ts, channel_id, messages) VALUES (?, ?, ?)',
    Math.floor((ts - HOUR) / HOUR) * HOUR,
    'c1',
    400,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.ok(tag.during.messages > 0, 'activity during the event is measured');
  // A ratio against zero baseline days is undefined; 0.0 would read as "no impact".
  assert.equal(tag.uplift, null);
  assert.equal(tag.baseline.days_observed, 0);
  assert.match(tag.note, /no usable baseline/i);
});

test('a long notes field survives the payload intact', () => {
  const { db, ts, addTag } = tagFixture({ installedDaysAgo: 30 });
  // 64 characters is where this used to stop, mid-list and with no marker, so
  // a complete note looked like a corrupted one.
  const notes = 'first match 11/07, final 11/22; match days 11/07, 11/08, 11/14, 11/15, 11/21, 11/22';
  addTag('Asia 1v1 Tournament', ts - 3 * DAY, ts + 11 * DAY, { notes });

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.notes, notes, 'nothing lost, nothing ellipsised');
});

test('notes past the cap are cut visibly, labels still cut at 64', () => {
  const { db, ts, addTag } = tagFixture({ installedDaysAgo: 30 });
  addTag('A'.repeat(200), ts - 3 * DAY, ts + 11 * DAY, { notes: 'x'.repeat(700) });

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.notes.length, 512);
  assert.ok(tag.notes.endsWith('…'), 'the cut is marked');
  assert.equal(tag.name.length, 64, 'labels keep the short cap');
  assert.ok(!tag.name.includes('…'), 'a label is a label, not prose');
});

test('partial days are counted per day, not per channel row', () => {
  const { db, ts } = tagFixture({ installedDaysAgo: 0 });
  const today = dayOf(ts);
  // The install day, seen in two channels. It is one partial day, not two.
  for (const ch of ['c1', 'c2']) {
    db.run(
      'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,1)',
      today,
      ch,
      5,
      2,
    );
  }
  db.run('INSERT INTO growth_day (day_ts, joins, leaves, members, partial) VALUES (?, 0, 0, 1101, 1)', today);

  const q = Q.qualityReport(db, cfg(), { ts });
  assert.equal(q.partial_days.messages, 1, 'two channels, one day');
  assert.equal(q.partial_days.growth, 1);
  assert.deepEqual(q.partial_days.recent.messages, [isoDate(today)], 'no repeat once per channel');
  assert.equal(q.first_full_day, null, 'the install day is never a full day');
});

test('first_full_day is the first day collection covered from midnight', () => {
  const { db, ts } = tagFixture({ installedDaysAgo: 3 });
  const installDay = dayOf(Math.floor(Date.parse(db.getMeta('backfill.completed')) / 1000));
  // The install day is partial; the day after it was watched end to end.
  db.run(
    'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,1)',
    installDay,
    'c1',
    5,
    2,
  );
  db.run(
    'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
    installDay + DAY,
    'c1',
    40,
    7,
  );

  const q = Q.qualityReport(db, cfg(), { ts });
  assert.equal(q.first_full_day, iso(installDay + DAY));
  assert.deepEqual(q.partial_days.recent.messages, [isoDate(installDay)]);
});

test('a partial window under six hours reports totals but no per-day rate', () => {
  const { db, ts, addTag } = tagFixture({ installedDaysAgo: 0 });
  // The live case: collection began three hours ago, two messages so far. A
  // daily rate here would be 2/3h = 16/day, which is noise wearing a number.
  const installed = ts - 3 * HOUR;
  db.setMeta('boot.first', new Date(installed * 1000).toISOString());
  db.setMeta('backfill.completed', new Date(installed * 1000).toISOString());
  addTag('Tournament starting 5 days ago', ts - 5 * DAY, ts + 5 * DAY);
  db.run(
    'INSERT INTO message_hour (hour_ts, channel_id, messages) VALUES (?, ?, ?)',
    Math.floor((ts - 2 * HOUR) / HOUR) * HOUR,
    'c1',
    2,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.during.messages, 2, 'the raw count survives');
  assert.equal(tag.during.messages_per_day, null, 'but not extrapolated');
  assert.ok(tag.during.observed.hours < 6);
  assert.equal(tag.during.observed.complete, false);
  assert.match(tag.note, /too short for a daily rate/);
});

test('a fully observed short event still reports a per-day rate', () => {
  const { db, ts, addTag } = tagFixture({ installedDaysAgo: 30 });
  // A two-hour match night that the collector saw in full: the extrapolation is
  // the point, since it is what gets compared against the baseline.
  const start = ts - 9 * DAY;
  addTag('Match night', start, start + 2 * HOUR);
  db.run(
    'INSERT INTO message_hour (hour_ts, channel_id, messages) VALUES (?, ?, ?)',
    start + HOUR,
    'c1',
    60,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.during.observed.complete, true);
  assert.ok(tag.during.messages_per_day > 0, 'complete window keeps its rate');
});

test('a baseline that is mostly in the future is reported as unusable, not diluted', () => {
  const { db, ts, addTag } = tagFixture({ installedDaysAgo: 0 });
  // Tagged for next week: the 28-day baseline ends before the event but its
  // overlap with collected time is a couple of hours. Dividing by the calendar
  // span made 2 messages read as 0.5/day.
  addTag('Next week', ts + 5 * DAY, ts + 7 * DAY);
  db.run(
    'INSERT INTO message_hour (hour_ts, channel_id, messages) VALUES (?, ?, ?)',
    Math.floor((ts - 600) / HOUR) * HOUR,
    'c1',
    2,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.status, 'upcoming');
  assert.ok(tag.baseline.coverage_span_days < 1, 'coverage is the observed slice, not the span');
  assert.equal(tag.baseline.messages_per_day, null, 'no diluted rate');
  assert.equal(tag.baseline.joins_per_day, null);
  assert.match(tag.note, /has not started/);
});

test('tags with the same start time come back newest-id first, deterministically', () => {
  const db = openDb(':memory:');
  const ts = now();
  const start = ts - 3 * DAY;
  for (const name of ['A', 'B', 'C']) {
    db.run(
      `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
       VALUES(?,?,?,?,?,?,?,?)`,
      name, start, start + DAY, 'match', null, null, null, ts,
    );
  }

  const first = Q.tags(db, cfg(), { limit: 5, ts }).tags.map((t) => t.name);
  const second = Q.tags(db, cfg(), { limit: 5, ts }).tags.map((t) => t.name);
  assert.deepEqual(first, ['C', 'B', 'A']);
  assert.deepEqual(first, second, 'stable across calls');
});

test('a tag with no joins reports joins_basis null, not "measured"', () => {
  const db = openDb(':memory:');
  const ts = now();
  const start = ts - 2 * HOUR;

  db.run(
    `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
     VALUES(?,?,?,?,?,?,?,?)`,
    'Quiet night', start, ts - HOUR, 'match', null, null, null, ts,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.during.joins, 0);
  assert.equal(tag.during.joins_basis, null, 'no joins is not "measured"');
});

test('a tag whose joins are part backfill, part measured reports mixed', () => {
  const db = openDb(':memory:');
  const ts = now();
  const start = ts - 3 * DAY;
  const installed = ts - 2 * DAY;
  db.setMeta('boot.first', new Date(installed * 1000).toISOString());
  db.setMeta('backfill.completed', new Date(installed * 1000).toISOString());
  db.setMeta('backfill.joinedAt.v1', '1');

  db.run(
    `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
     VALUES(?,?,?,?,?,?,?,?)`,
    'Spanning install', start, ts, 'tournament', null, null, null, ts,
  );
  // One member joined inside the window, known only from the join-date backfill.
  db.run('INSERT INTO growth_backfill(day_ts, joins) VALUES(?,?)', dayOf(start + HOUR), 1);
  // One join the collector actually watched happen.
  db.run('INSERT INTO growth_day(day_ts, joins, leaves) VALUES(?,?,?)', dayOf(ts), 1, 0);

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.during.joins, 2);
  assert.equal(tag.during.joins_basis, 'mixed');
});

test('baseline coverage is not floored at one day when nothing was observed', () => {
  const db = openDb(':memory:');
  const ts = now();
  const installed = ts - 2 * HOUR;
  db.setMeta('boot.first', new Date(installed * 1000).toISOString());
  db.setMeta('backfill.completed', new Date(installed * 1000).toISOString());

  // Window opened before install, so its 28-day baseline is entirely unobserved.
  db.run(
    `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
     VALUES(?,?,?,?,?,?,?,?)`,
    'Before install', ts - 2 * DAY, ts - DAY, 'match', null, null, null, ts,
  );

  const [tag] = Q.tags(db, cfg(), { limit: 5, ts }).tags;
  assert.equal(tag.baseline.days_observed, 0);
  assert.equal(tag.baseline.coverage_span_days, 0, 'no baseline coverage, not 1');
  assert.equal(tag.uplift, null);
});

test('the empty-dataset caveat names the window the same way as the coverage caveat', () => {
  const db = openDb(':memory:');
  const ts = now();
  db.setMeta('boot.first', new Date(ts * 1000).toISOString());

  const p = Q.summary(db, cfg(), { window: window30, ts });
  const text = p.caveats.join(' ');
  assert.match(text, /30-day window/);
  assert.doesNotMatch(text, /30d window/, 'raw parameter label leaked into prose');
});

/**
 * Boot re-adoption when the member cache lost the member. `state.member` is a getter
 * over guild.members.cache, so it returns null for a swept member; the old code then
 * skipped that voice state, and a restart left whoever was in a call uncounted until
 * they muted, moved or left. The data looks identical to an idle server, so this went
 * unnoticed until a live session stalled right after a redeploy.
 */
