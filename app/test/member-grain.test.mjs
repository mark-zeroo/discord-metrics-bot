import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { createIdentity } from '../src/privacy.js';
import { createMessageCollector } from '../src/collectors/messages.js';
import { createVoiceCollector } from '../src/collectors/voice.js';
import { createMemberCollector } from '../src/collectors/members.js';
import { createMaintenance } from '../src/maintenance.js';
import { silentLogger } from '../src/log.js';
import { DAY, dayOf, hourOf } from '../src/time.js';
import { makeConfig } from './fixtures.mjs';

const GUILD = '1';
const KEY = 'k'.repeat(64);

const identity = (mode = 'hmac') =>
  createIdentity({ mode, hmacKey: mode === 'hmac' ? KEY : undefined, guildId: GUILD });

const now = () => Math.floor(Date.now() / 1000);

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

function member(userId, joinedTs, { bot = false } = {}) {
  return {
    user: { id: userId, bot },
    joinedTimestamp: joinedTs * 1000,
    joinedAt: new Date(joinedTs * 1000),
    guild: { id: GUILD },
    roles: { cache: new Map() },
  };
}

// ------------------------------------------------------------- member_day

test('member_day is written per member per day in hmac mode', () => {
  const db = openDb(':memory:');
  const collector = createMessageCollector({
    identity: identity('hmac'),
    excludedRoleIds: new Set(),
    perChannel: true,
  });

  const ts = now();
  for (let i = 0; i < 3; i += 1) collector.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  collector.onMessage(message('bob', 'c1', ts - DAY), { guildId: GUILD });
  collector.flush(db, ts);

  const rows = db.all('SELECT day_ts, user_hmac, messages FROM member_day ORDER BY messages DESC');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].messages, 3);
  assert.equal(rows[0].day_ts, dayOf(ts));
  assert.equal(rows[1].messages, 1);
  assert.equal(rows[1].day_ts, dayOf(ts - DAY));
  // Pseudonyms only: a raw id in this table would be a per-person record.
  assert.ok(rows.every((r) => r.user_hmac !== 'alice' && r.user_hmac !== 'bob'));
});

test('member_day is not written when per-member counters are off', () => {
  const db = openDb(':memory:');
  const collector = createMessageCollector({
    identity: identity('off'),
    excludedRoleIds: new Set(),
    perChannel: true,
  });

  const ts = now();
  collector.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  collector.flush(db, ts);

  assert.equal(db.get('SELECT COUNT(*) AS n FROM member_day').n, 0);
});

test('member_day accumulates across a restart instead of replacing the day', () => {
  const db = openDb(':memory:');
  const ts = now();

  const first = createMessageCollector({
    identity: identity('hmac'),
    excludedRoleIds: new Set(),
    perChannel: true,
  });
  first.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  first.flush(db, ts);

  // A second process sees the same day with its own counter starting at zero. It
  // must add, not overwrite: the day's total is 2, not "1 since this boot".
  const second = createMessageCollector({
    identity: identity('hmac'),
    excludedRoleIds: new Set(),
    perChannel: true,
  });
  second.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  second.flush(db, ts);

  const row = db.get('SELECT messages FROM member_day WHERE day_ts = ?', dayOf(ts));
  assert.equal(row.messages, 2);
});

test('message and voice collectors share one member_day row without clobbering', () => {
  const db = openDb(':memory:');
  const ts = now();
  const id = identity('hmac');

  const msgs = createMessageCollector({ identity: id, excludedRoleIds: new Set(), perChannel: true });
  msgs.onMessage(message('alice', 'c1', ts), { guildId: GUILD });
  msgs.flush(db, ts);

  const voice = createVoiceCollector({ identity: id, excludedRoleIds: new Set() });
  voice.onVoiceStateUpdate(
    { channelId: null, selfMute: false, selfDeaf: false, serverDeaf: false, guild: { id: GUILD }, member: member('alice', ts - 10 * DAY) },
    {
      channelId: 'vc1',
      selfMute: false,
      selfDeaf: false,
      serverDeaf: false,
      guild: { id: GUILD },
      member: member('alice', ts - 10 * DAY),
    },
    { guildId: GUILD },
  );
  // Advance the session so it accrues, then flush.
  voice.flush(db, ts + 60);

  const row = db.get('SELECT messages, voice_s FROM member_day WHERE day_ts = ?', dayOf(ts));
  assert.ok(row, 'one row for the member and day');
  assert.equal(row.messages, 1, 'messages survived the voice write');
  assert.ok(row.voice_s > 0, 'voice seconds were recorded');
});

// ----------------------------------------------------------- member_tenure

test('a join records a membership span from Discord join time, not now', () => {
  const db = openDb(':memory:');
  const collector = createMemberCollector({ identity: identity('hmac') });
  const ts = now();
  const joined = ts - 40 * DAY;

  collector.onJoin(member('alice', joined), { now: ts });
  collector.flush(db, ts);

  const row = db.get('SELECT * FROM member_tenure');
  assert.equal(row.joined_ts, joined);
  assert.equal(row.left_ts, null);
  assert.equal(row.source, 'live');
  assert.notEqual(row.user_hmac, 'alice');
});

test('a leave closes the span, and a rejoin opens a new one', () => {
  const db = openDb(':memory:');
  const collector = createMemberCollector({ identity: identity('hmac') });
  const ts = now();

  collector.onJoin(member('alice', ts - 60 * DAY), { now: ts - 60 * DAY });
  collector.flush(db, ts - 60 * DAY);

  collector.onLeave(member('alice', ts - 30 * DAY), { now: ts - 30 * DAY });
  collector.flush(db, ts - 30 * DAY);

  collector.onJoin(member('alice', ts - 5 * DAY), { now: ts - 5 * DAY });
  collector.flush(db, ts - 5 * DAY);

  const rows = db.all('SELECT joined_ts, left_ts FROM member_tenure ORDER BY joined_ts');
  assert.equal(rows.length, 2, 'a rejoin is a second cohort, not an edit of the first');
  assert.equal(rows[0].joined_ts, ts - 60 * DAY);
  assert.equal(rows[0].left_ts, ts - 30 * DAY);
  assert.equal(rows[1].joined_ts, ts - 5 * DAY);
  assert.equal(rows[1].left_ts, null);
});

test('membership spans are never written with counters off', () => {
  const db = openDb(':memory:');
  const collector = createMemberCollector({ identity: identity('off') });
  const ts = now();

  collector.onJoin(member('alice', ts), { now: ts });
  collector.onLeave(member('alice', ts), { now: ts });
  collector.flush(db, ts);

  assert.equal(db.get('SELECT COUNT(*) AS n FROM member_tenure').n, 0);
  // The counters themselves still move: joins are a number, not a person.
  assert.equal(db.get('SELECT joins FROM growth_day').joins, 1);
});

test('a repeated join at the same timestamp does not duplicate a span', () => {
  const db = openDb(':memory:');
  const collector = createMemberCollector({ identity: identity('hmac') });
  const ts = now();

  collector.onJoin(member('alice', ts - DAY), { now: ts });
  collector.flush(db, ts);
  // The backfill can observe the same join again; that must be idempotent.
  collector.onJoin(member('alice', ts - DAY), { now: ts });
  collector.flush(db, ts);

  assert.equal(db.get('SELECT COUNT(*) AS n FROM member_tenure').n, 1);
});

// -------------------------------------------------------------- retention sweep

test('the retention sweep prunes member_day and closed old tenures only', () => {
  const db = openDb(':memory:');
  const config = makeConfig({ PER_MEMBER_COUNTERS: 'hmac' });
  const ts = now();
  const oldDay = dayOf(ts) - 800 * DAY; // past RETENTION_DAILY_DAYS (730)
  const recentDay = dayOf(ts) - 10 * DAY;

  db.run('INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)', oldDay, 'old', 1);
  db.run('INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)', recentDay, 'new', 1);

  const insertTenure = (key, joined, left) =>
    db.run(
      'INSERT INTO member_tenure(user_hmac, joined_ts, left_ts, source, recorded_ts) VALUES(?,?,?,?,?)',
      key, joined, left, 'live', ts,
    );
  insertTenure('gone-long-ago', oldDay, oldDay + DAY);
  insertTenure('joined-long-ago-still-here', oldDay, null);
  insertTenure('recently-left', recentDay, recentDay + DAY);

  const maintenance = createMaintenance({
    db,
    config,
    collectors: { messages: { flush() {}, stats: () => ({}) }, voice: { flush() {}, stats: () => ({}) }, members: { flush() {} } },
    bot: null,
    logger: silentLogger,
  });
  maintenance.prune(ts);

  assert.equal(db.get('SELECT COUNT(*) AS n FROM member_day').n, 1, 'old per-member days pruned');
  const spans = db.all('SELECT user_hmac FROM member_tenure ORDER BY user_hmac').map((r) => r.user_hmac);
  assert.deepEqual(spans, ['joined-long-ago-still-here', 'recently-left']);
});
