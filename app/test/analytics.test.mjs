import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markDayPartial, openDb } from '../src/db.js';
import { createIdentity } from '../src/privacy.js';
import { createMessageCollector } from '../src/collectors/messages.js';
import { createVoiceCollector } from '../src/collectors/voice.js';
import * as Q from '../src/api/queries.js';
import { STATUS } from '../src/api/suppression.js';
import { DAY, HOUR, dayOf, hourOf, iso, isoDate } from '../src/time.js';
import { makeConfig } from './fixtures.mjs';

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

test('poster_day deduplicates a member active in two channels', () => {
  const db = openDb(':memory:');
  const identity = createIdentity({ mode: 'off', guildId: GUILD });
  const collector = createMessageCollector({
    identity,
    excludedRoleIds: new Set(),
    perChannel: true,
  });

  const ts = now();
  // A posts twice in two channels, B posts once. Per-channel distinct sums to 3,
  // the guild-wide headcount is 2.
  collector.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  collector.onMessage(message('alice', 'c2', ts), { guildId: GUILD });
  collector.onMessage(message('bob', 'c1', ts), { guildId: GUILD });

  collector.flush(db, ts);

  const row = db.get('SELECT posters FROM poster_day WHERE day_ts = ?', dayOf(ts));
  const perChannel = db.get('SELECT SUM(unique_authors) AS n FROM message_day WHERE day_ts = ?', dayOf(ts));

  assert.equal(row.posters, 2, 'guild-wide distinct posters');
  assert.equal(perChannel.n, 3, 'per-channel sum over-counts, which is the bug being fixed');
});

test('poster counts are idempotent across repeated flushes', () => {
  const db = openDb(':memory:');
  const identity = createIdentity({ mode: 'off', guildId: GUILD });
  const collector = createMessageCollector({
    identity,
    excludedRoleIds: new Set(),
    perChannel: false,
  });

  const ts = now();
  collector.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  collector.flush(db, ts);
  collector.flush(db, ts);
  collector.flush(db, ts);

  const row = db.get('SELECT posters FROM poster_day WHERE day_ts = ?', dayOf(ts));
  assert.equal(row.posters, 1);
});

// ------------------------------------------------------- per-member write path

test('member_hour is not written when per-member counters are off', () => {
  const db = openDb(':memory:');
  const identity = createIdentity({ mode: 'off', guildId: GUILD });
  const collector = createMessageCollector({
    identity,
    excludedRoleIds: new Set(),
    perChannel: true,
  });

  const ts = now();
  collector.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  collector.flush(db, ts);

  const row = db.get('SELECT COUNT(*) AS n FROM member_hour');
  assert.equal(row.n, 0);
});

test('member_hour records per-member message counts in hmac mode', () => {
  const db = openDb(':memory:');
  const identity = createIdentity({ mode: 'hmac', hmacKey: 'k'.repeat(64), guildId: GUILD });
  const collector = createMessageCollector({
    identity,
    excludedRoleIds: new Set(),
    perChannel: true,
  });

  const ts = now();
  for (let i = 0; i < 5; i += 1) {
    collector.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  }
  collector.onMessage(message('bob', 'c2', ts), { guildId: GUILD });
  collector.flush(db, ts);

  const rows = db.all('SELECT user_hmac, messages FROM member_hour ORDER BY messages DESC');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].messages, 5);
  assert.equal(rows[1].messages, 1);
  // Pseudonyms, never raw ids.
  assert.ok(rows.every((r) => r.user_hmac !== 'alice' && r.user_hmac !== 'bob'));
});

test('voice and message collectors share a member_hour row without clobbering', () => {
  // Freeze the clock at the start of an hour. The collector stamps a join with
  // Date.now() and this test flushes 120s later, so running in the last two
  // minutes of an hour split those seconds across two member_hour rows — which
  // is correct behaviour, just not what this test is about.
  const frozenMs = (hourOf(Math.floor(Date.now() / 1000)) + 600) * 1000;
  const realDateNow = Date.now;
  Date.now = () => frozenMs;
  try {
    return shareMemberHourRow();
  } finally {
    Date.now = realDateNow;
  }
});

function shareMemberHourRow() {
  const db = openDb(':memory:');
  const identity = createIdentity({ mode: 'hmac', hmacKey: 'k'.repeat(64), guildId: GUILD });

  const messages = createMessageCollector({
    identity,
    excludedRoleIds: new Set(),
    perChannel: true,
  });
  const voice = createVoiceCollector({ identity, excludedRoleIds: new Set() });

  const ts = now();
  voice.onVoiceStateUpdate(
    { channelId: null, guild: { id: GUILD } },
    {
      guild: { id: GUILD },
      member: { user: { id: 'alice', bot: false }, roles: { cache: new Map() } },
      channelId: 'v1',
      selfDeaf: false,
      serverDeaf: false,
      selfMute: false,
    },
    { guildId: GUILD },
  );
  // Flush voice first so its row exists, then let messages write to it.
  voice.flush(db, ts + 120);
  messages.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  messages.flush(db, ts + 120);

  const row = db.get('SELECT messages, voice_s FROM member_hour WHERE hour_ts = ?', hourOf(ts));
  assert.equal(row.messages, 1, 'message count survives the voice row');
  assert.ok(row.voice_s >= 120, `voice seconds survive the message row (got ${row.voice_s})`);
}

test('boot adopts members already in voice, billing only from boot forward', () => {
  const db = openDb(':memory:');
  const identity = createIdentity({ mode: 'hmac', hmacKey: 'k'.repeat(64), guildId: GUILD });
  const voice = createVoiceCollector({ identity, excludedRoleIds: new Set(), afkChannelId: 'afk' });

  // Anchored inside an hour so the 60s below cannot straddle a bucket boundary.
  const ts = hourOf(now()) + 120;

  const member = (id) => ({ user: { id, bot: false }, roles: { cache: new Map() } });
  const state = (channelId, m, extra = {}) => ({
    channelId,
    member: m,
    selfDeaf: false,
    serverDeaf: false,
    selfMute: false,
    ...extra,
  });

  const cache = new Map([
    ['alice', state('v1', member('alice'))],
    ['bot1', state('v1', { user: { id: 'bot1', bot: true }, roles: { cache: new Map() } })],
    ['bob', state('v2', member('bob'), { selfDeaf: true })],
    ['carol', state('afk', member('carol'))],
    ['dave', state(null, member('dave'))],
  ]);

  // Default mode is 'present': a self-deafened member is still sitting in the
  // call, and on a phone-first server that is the normal state. alice + bob.
  const opened = voice.seed({ voiceStates: { cache } }, ts);
  assert.equal(opened, 2, 'everyone in a real channel is adopted, muted or not');
  assert.equal(voice.stats().activeSessions, 2);
  assert.equal(voice.stats().countMode, 'present');

  // A second seed must not re-open or rewind the cursor.
  assert.equal(voice.seed({ voiceStates: { cache } }, ts + 30), 0);
  assert.equal(voice.stats().activeSessions, 2);

  voice.flush(db, ts + 60);
  const row = db.get(
    'SELECT seconds FROM voice_hour WHERE hour_ts = ? AND channel_id = ?',
    hourOf(ts),
    'v1',
  );
  assert.equal(row.seconds, 60, 'bills from boot forward, never backwards');
});

test('unmuted mode keeps the old behaviour: muted members are not in the call', () => {
  // Opt-in mode, for a server that wants voice to mean "people who can talk".
  const db = openDb(':memory:');
  const identity = createIdentity({ mode: 'hmac', hmacKey: 'k'.repeat(64), guildId: GUILD });
  const voice = createVoiceCollector({
    identity,
    excludedRoleIds: new Set(),
    afkChannelId: 'afk',
    countMode: 'unmuted',
  });

  const ts = hourOf(now()) + 120;
  const member = (id) => ({ user: { id, bot: false }, roles: { cache: new Map() } });
  const state = (channelId, m, extra = {}) => ({
    channelId,
    member: m,
    selfDeaf: false,
    serverDeaf: false,
    selfMute: false,
    ...extra,
  });
  const cache = new Map([
    ['alice', state('v1', member('alice'))],
    ['bob', state('v2', member('bob'), { selfDeaf: true })],
    ['carol', state('v3', member('carol'), { selfMute: true })],
    ['dave', state('v4', member('dave'), { serverDeaf: true })],
  ]);

  assert.equal(voice.seed({ voiceStates: { cache } }, ts), 1);
  assert.equal(voice.stats().countMode, 'unmuted');

  voice.flush(db, ts + 60);
  const rows = db.all('SELECT channel_id, seconds FROM voice_hour WHERE hour_ts = ?', hourOf(ts));
  assert.deepEqual(
    rows.map((r) => r.channel_id),
    ['v1'],
    'only the unmuted member accrues voice time',
  );
});

test('a muted member joining still counts as present, unmuting later is not a rejoin', () => {
  const identity = createIdentity({ mode: 'hmac', hmacKey: 'k'.repeat(64), guildId: GUILD });
  const voice = createVoiceCollector({ identity, excludedRoleIds: new Set() });

  const ts = hourOf(now()) + 120;
  const base = {
    guild: { id: GUILD },
    member: { user: { id: 'alice', bot: false }, roles: { cache: new Map() } },
  };

  // Join muted: the session opens anyway, which is the whole point of 'present'.
  voice.onVoiceStateUpdate(
    { ...base, channelId: null },
    { ...base, channelId: 'v1', selfMute: true, selfDeaf: false, serverDeaf: false },
    { guildId: GUILD },
  );
  assert.equal(voice.stats().activeSessions, 1, 'joining muted opens a session');

  // Unmuting must not close and reopen it (that would leak the elapsed time).
  voice.onVoiceStateUpdate(
    { ...base, channelId: 'v1', selfMute: true },
    { ...base, channelId: 'v1', selfMute: false, selfDeaf: false, serverDeaf: false },
    { guildId: GUILD },
  );
  assert.equal(voice.stats().activeSessions, 1);
  assert.equal(voice.stats().started, 1, 'no duplicate session from unmuting');

  // Leaving closes it.
  voice.onVoiceStateUpdate(
    { ...base, channelId: 'v1' },
    { ...base, channelId: null },
    { guildId: GUILD },
  );
  assert.equal(voice.stats().activeSessions, 0);
});

test('seed tolerates a guild with no voice state cache', () => {
  const identity = createIdentity({ mode: 'hmac', hmacKey: 'k'.repeat(64), guildId: GUILD });
  const voice = createVoiceCollector({ identity, excludedRoleIds: new Set() });
  assert.equal(voice.seed({}), 0);
  assert.equal(voice.seed(null), 0);
  assert.equal(voice.stats().activeSessions, 0);
});

// ------------------------------------------------------------- concentration

function seedConcentration(db) {
  const ts = hourOf(now());
  const counts = [100, 50, 20, 10, 5, 3, 2, 1, 1, 1];
  counts.forEach((n, i) => {
    db.run(
      'INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)',
      ts,
      `m${String(i).padStart(2, '0')}`,
      n,
    );
  });
  // Coverage, not activity: a zero-message row at the start of the 30-day window,
  // so MIN(hour_ts) reaches back as far as the window does.
  db.run(
    'INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s) VALUES(?,?,0,0)',
    hourOf(now() - 30 * DAY),
    'coverage',
  );
  db.run(
    'INSERT INTO snapshot(ts, members, bots, online, boosts, tier, channels, roles) VALUES(?,?,?,?,?,?,?,?)',
    now(), 100, 5, 10, 1, 0, 10, 5,
  );
  return counts;
}

test('engagement reports the concentration of messaging', () => {
  const db = openDb(':memory:');
  const counts = seedConcentration(db);

  // A floor of 2 keeps the band arithmetic visible; the default floor of 10 is
  // exercised by the next test.
  const out = Q.engagement(db, cfg({ minCell: 2 }), { window: window30 });

  assert.equal(out.available, true);
  assert.equal(out.active_members.value, 10);
  assert.equal(out.total_messages, counts.reduce((a, b) => a + b, 0));

  // 100, then 150, then 170 of 193 total — three members cover 80%.
  assert.equal(out.concentration.members_for_80_percent_of_messages.value, 3);
  // Top 10% of 10 members is one member with 100 of 193.
  assert.equal(out.concentration.share_of_messages_from_top_10_percent, 0.518);
  assert.equal(out.concentration.median_messages_per_active_member, 4);

  const dist = Object.fromEntries(out.concentration.distribution.map((b) => [b.band, b.members]));
  assert.equal(
    Object.values(dist).reduce((a, b) => a + (b.value ?? 0), 0),
    10,
    'bands cover every active member',
  );
  assert.equal(dist['50-199'].value, 2, 'the 50- and 100-message members');
  assert.equal(dist['1-9'].value, 6);

  assert.ok(out.concentration.gini > 0.4 && out.concentration.gini < 1);
  // 95 humans in the snapshot, 10 of them posted.
  assert.equal(out.lurkers.humans, 95);
  assert.equal(out.lurkers.active_share_of_humans, 0.105);
});

test('engagement withholds a band and its neighbour when the floor makes one recoverable', () => {
  const db = openDb(':memory:');
  seedConcentration(db);

  // Default floor 10: 3 members produce 80% of messages, which names those three,
  // and every band below 10 members is withheld. active_members (10) still
  // publishes, and the bands are too many to recover individually.
  const out = Q.engagement(db, cfg(), { window: window30 });
  assert.equal(out.active_members.value, 10);
  assert.equal(out.concentration.members_for_80_percent_of_messages.value, null);
  assert.equal(out.concentration.members_for_80_percent_of_messages.status, STATUS.suppressed_small_count);

  const published = out.concentration.distribution.filter((b) => b.members.value !== null);
  // Only the empty bands publish: a zero says nobody is there, which identifies
  // nobody. Every band with members in it is withheld.
  assert.deepEqual(published.map((b) => b.band), ['200-999', '1000+']);
  assert.ok(published.every((b) => b.members.value === 0));
  assert.ok(out.concentration.distribution_suppressed >= 2);
  assert.equal(out.suppression.min_cell, 10);
  assert.ok(out.status_legend.suppressed_small_count);
});

test('engagement withholds concentration entirely below the floor', () => {
  const db = openDb(':memory:');
  const ts = hourOf(now());
  for (let i = 0; i < 4; i += 1) {
    db.run(
      'INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)',
      ts, `small${i}`, 10,
    );
  }
  db.run(
    'INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s) VALUES(?,?,0,0)',
    hourOf(now() - 30 * DAY), 'coverage',
  );

  const out = Q.engagement(db, cfg(), { window: window30 });
  assert.equal(out.concentration, null);
  assert.equal(out.concentration_status.status, STATUS.suppressed_small_count);
  assert.equal(out.active_members.value, null);
  assert.equal(out.lurkers.active_share_of_humans, null, 'the share would recover the count');
  assert.match(out.concentration_status.reason, /anonymity floor/);
});

test('engagement is unavailable rather than wrong when counters are off', () => {
  const db = openDb(':memory:');
  seedConcentration(db);

  const out = Q.engagement(db, cfg({ perMemberCounters: 'off' }), { window: window30 });
  assert.equal(out.available, false);
  assert.match(out.reason, /PER_MEMBER_COUNTERS/);
  assert.equal(out.concentration, undefined);
});

test('engagement caps the window to hourly retention and says so', () => {
  const db = openDb(':memory:');
  seedConcentration(db);

  const out = Q.engagement(db, cfg(), { window: { label: '365d', seconds: 365 * DAY, all: false } });
  assert.equal(out.window_capped, true);
  assert.ok(out.caveats.some((c) => /Capped to hourly retention/.test(c)));
});

// ---------------------------------------------------------------- event tags

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
  assert.equal(tag.baseline.days_covered, 28);
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

test('a boot re-flags rows left unflagged by the previous day\'s process', () => {
  const db = openDb(':memory:');
  const now = Math.floor(Date.now() / 1000);
  const today = dayOf(now);
  const yesterday = today - DAY;

  // Exactly the live shape: the process that booted yesterday wrote today's
  // traffic, so it could only judge "did *I* boot mid-day" and wrote partial = 0.
  db.run(
    'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
    today,
    'game-chat',
    41,
    3,
  );
  db.run(
    'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
    yesterday,
    'game-chat',
    580,
    13,
  );

  assert.equal(Q.qualityReport(db, cfg()).partial_days.messages, 0, 'nothing flagged yet');

  // Boot today: whatever happened before this process started is uncounted.
  const updated = markDayPartial(db, today);
  assert.equal(updated, 1, 'only today is repaired');

  const out = Q.qualityReport(db, cfg());
  assert.equal(out.partial_days.messages, 1);
  assert.deepEqual(out.partial_days.recent.messages, [isoDate(today)]);
  assert.equal(
    db.get('SELECT partial FROM message_day WHERE day_ts = ?', yesterday).partial,
    0,
    'a completed day is not dragged into partial',
  );
});

test('markDayPartial covers messages, voice and growth together', () => {
  const db = openDb(':memory:');
  const today = dayOf(Math.floor(Date.now() / 1000));
  db.run('INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)', today, 'c1', 5, 1);
  db.run('INSERT INTO voice_day(day_ts, channel_id, seconds, unique_users, partial) VALUES(?,?,?,?,0)', today, 'v1', 600, 2);
  db.run('INSERT INTO growth_day(day_ts, joins, leaves, members, bots, partial) VALUES(?,?,?,?,?,0)', today, 2, 0, 1101, 4);

  assert.equal(markDayPartial(db, today), 3);
  assert.equal(Q.qualityReport(db, cfg()).partial_days.voice, 1);
  assert.equal(Q.qualityReport(db, cfg()).partial_days.growth, 1);
});

test('the voice caveat describes how restarts actually behave', () => {
  const db = openDb(':memory:');
  const ts = now();
  const out = Q.voice(db, cfg(), { window: window30, bucket: 'day', top: 5, ts });
  const caveats = out.caveats.join(' ');
  // This caveat used to claim restarts discard in-flight sessions. They no longer
  // do — shutdown flushes and boot re-adopts — so leaving the old wording in place
  // would read as an explanation for a gap that no longer exists.
  assert.doesNotMatch(caveats, /discarded/i);
  assert.match(caveats, /re-adopted at boot/);
  assert.match(caveats, /SIGKILL/, 'the gap that does remain is named');
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
  assert.ok(tag.baseline.days_covered < 1, 'coverage is the observed slice, not the span');
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
  assert.equal(tag.baseline.days_covered, 0, 'no baseline coverage, not 1');
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
test('seed adopts a member whose voice state has no member object', () => {
  const db = openDb(':memory:');
  const identity = createIdentity({ mode: 'off', guildId: '1' });
  const v = createVoiceCollector({ identity, excludedRoleIds: new Set() });

  const member = { user: { id: 'u1', bot: false }, roles: { cache: new Map() } };
  const guild = {
    voiceStates: {
      cache: new Map([['u1', { id: 'u1', channelId: 'lobby', member: null }]]),
    },
    members: { cache: new Map([['u1', member]]) },
  };

  assert.equal(v.seed(guild, 1_000), 1, 'should resolve the member from the guild cache');
  const stats = v.stats();
  assert.equal(stats.activeSessions, 1);
  assert.equal(stats.lastSeedUnknown, 0, 'resolved via cache, so nothing unknown');
  v.abandonAll();
  db.close();
});

/**
 * ...and when the member genuinely is not cached, say so instead of returning a bare
 * zero. An unresolvable state cannot be classified as bot or human, so it is skipped —
 * but the count makes the skip visible.
 */
test('seed counts voice states it cannot resolve to a member', () => {
  const identity = createIdentity({ mode: 'off', guildId: '1' });
  const v = createVoiceCollector({ identity, excludedRoleIds: new Set() });
  const guild = {
    voiceStates: { cache: new Map([['u1', { id: 'u1', channelId: 'lobby', member: null }]]) },
    members: { cache: new Map() },
  };

  assert.equal(v.seed(guild, 1_000), 0);
  const stats = v.stats();
  assert.equal(stats.lastSeedStates, 1, 'the voice state was visible');
  assert.equal(stats.lastSeedUnknown, 1, 'but not resolvable, which is now reported');
});
