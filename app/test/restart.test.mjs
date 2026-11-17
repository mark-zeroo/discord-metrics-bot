// A restart inside a day used to rewrite that day's row down to "messages seen
// since boot". These tests run the collector twice against one database, the way
// a container restart does, and pin the rule: a row already flagged `partial` is
// accumulated into, a complete row is raised but never lowered.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { createMessageCollector } from '../src/collectors/messages.js';
import { createIdentity } from '../src/privacy.js';
import { dayOf, hourOf } from '../src/time.js';

const GUILD = '123456789012345678';
const CHANNEL = '111111111111111111';

function collector() {
  return createMessageCollector({
    identity: createIdentity({ mode: 'off', guildId: GUILD }),
    excludedRoleIds: new Set(),
    perChannel: true,
  });
}

function message(id = '1') {
  return {
    inGuild: () => true,
    guildId: GUILD,
    system: false,
    channelId: CHANNEL,
    author: { id, bot: false },
    member: { roles: { cache: { has: () => false } } },
    createdTimestamp: Date.now(),
  };
}

function say(c, n, authorId = '1') {
  for (let i = 0; i < n; i += 1) c.onMessage(message(authorId), { guildId: GUILD });
}

const readDay = (db, d = dayOf(Date.now() / 1000)) =>
  db.get('SELECT messages, partial FROM message_day WHERE day_ts=? AND channel_id=?', d, CHANNEL);

test('a restart mid-day accumulates into the row the first process left partial', () => {
  const db = openDb(':memory:');

  const first = collector();
  say(first, 22);
  first.flush(db);
  assert.deepEqual({ ...readDay(db) }, { messages: 22, partial: 1 }, 'booted mid-day: partial');
  assert.equal(db.get('SELECT messages FROM message_hour WHERE channel_id=?', CHANNEL).messages, 22);

  // New process, same day, same hour. Its counters start at zero.
  const second = collector();
  say(second, 8);
  second.flush(db);

  const day = readDay(db);
  assert.equal(day.messages, 30, 'the day keeps the first process\'s 22 instead of being rewritten to 8');
  assert.equal(day.partial, 1, 'still not a whole day, so still partial');
  assert.equal(
    db.get('SELECT messages FROM message_hour WHERE channel_id=?', CHANNEL).messages,
    30,
    'hours merge rather than replace, because two processes can share one hour',
  );
});

test('repeated flushes from one process do not double count', () => {
  const db = openDb(':memory:');
  const c = collector();

  say(c, 5);
  c.flush(db);
  c.flush(db);
  c.flush(db);

  assert.equal(readDay(db).messages, 5);
  assert.equal(db.get('SELECT messages FROM message_hour WHERE channel_id=?', CHANNEL).messages, 5);
});

test('a row left partial by an earlier boot keeps accumulating across several restarts', () => {
  const db = openDb(':memory:');
  for (const batch of [7, 11, 3]) {
    const c = collector();
    say(c, batch);
    c.flush(db);
  }
  assert.equal(readDay(db).messages, 21);
});

test('a row that was complete is raised, not lowered, when a later process sees less', () => {
  const db = openDb(':memory:');
  const today = dayOf(Date.now() / 1000);
  db.run(
    'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
    today,
    CHANNEL,
    140,
    12,
  );

  const c = collector();
  say(c, 4);
  c.flush(db);

  const row = readDay(db);
  assert.equal(row.messages, 140, 'MAX semantics: a since-boot counter can never shrink a day');
  assert.equal(row.partial, 1, 'but the day is now known to be incomplete');
});

test('the day total never falls below the hours that compose it', () => {
  const db = openDb(':memory:');
  for (const batch of [9, 1, 14]) {
    const c = collector();
    say(c, batch);
    c.flush(db, Math.floor(Date.now() / 1000));
  }

  const day = readDay(db).messages;
  const hours = db.get(
    'SELECT COALESCE(SUM(messages),0) AS h FROM message_hour WHERE hour_ts >= ?',
    dayOf(Date.now() / 1000),
  ).h;
  assert.equal(day, hours);
});

test('hour buckets are keyed independently of the day bucket', () => {
  const db = openDb(':memory:');
  const c = collector();
  say(c, 3);
  c.flush(db);

  const h = hourOf(Date.now() / 1000);
  assert.ok(db.get('SELECT messages FROM message_hour WHERE hour_ts=?', h).messages === 3);
  assert.ok(db.get('SELECT messages FROM message_day WHERE day_ts=?', dayOf(h)).messages === 3);
});
