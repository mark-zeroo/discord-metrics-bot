import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markDayPartial, openDb } from '../src/db.js';
import { createIdentity } from '../src/privacy.js';
import { createMessageCollector } from '../src/collectors/messages.js';
import { createVoiceCollector } from '../src/collectors/voice.js';
import * as Q from '../src/api/queries.js';
import { DAY, dayOf, hourOf, isoDate } from '../src/time.js';
import { makeConfig } from './fixtures.mjs';

const GUILD = '1';
const window30 = { label: '30d', seconds: 30 * DAY, all: false };

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
