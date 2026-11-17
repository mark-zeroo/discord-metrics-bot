// The repair tool exists because the collector once wrote post-restart counters
// over a day's real total. These tests pin the two properties that make the fix
// safe to run on a live database: it only ever raises a value, and it flags the
// repaired row `partial` so the running collector accumulates into it instead of
// flattening it again on the next flush.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { findDayGaps, findPosterGaps, apply } from '../src/cli/repair.js';
import { DAY, HOUR, dayOf, hourOf } from '../src/time.js';

const now = () => Math.floor(Date.now() / 1000);

const MESSAGE_SPEC = {
  dayTable: 'message_day',
  hourTable: 'message_hour',
  sumColumn: 'messages',
  distinctColumn: 'unique_authors',
};

function insertHour(db, hourTs, channelId, messages, authors = 1) {
  db.run(
    'INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors) VALUES(?,?,?,?)',
    hourTs,
    channelId,
    messages,
    authors,
  );
}

function insertDay(db, dayTs, channelId, messages, authors = 1, partial = 0) {
  db.run(
    `INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial)
     VALUES(?,?,?,?,?)`,
    dayTs,
    channelId,
    messages,
    authors,
    partial,
  );
}

const dayRow = (db, dayTs, channelId) =>
  db.get(
    'SELECT messages, unique_authors, partial FROM message_day WHERE day_ts=? AND channel_id=?',
    dayTs,
    channelId,
  );

// ------------------------------------------------------------------ the bug

test('repair finds a day counter that a restart overwrote', () => {
  const db = openDb(':memory:');
  const d = dayOf(now());

  // The shape seen in production: the day row kept the counter of whichever
  // process booted last (8), while its hourly rows hold 8 + 22 = 30.
  insertDay(db, d, 'c1', 8, 3, 1);
  insertHour(db, hourOf(now()), 'c1', 8, 3);
  insertHour(db, hourOf(now()) - HOUR, 'c1', 22, 5);

  const { gaps } = findDayGaps(db, MESSAGE_SPEC);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].stored, 8);
  assert.equal(gaps[0].from_hours, 30);
  assert.equal(gaps[0].delta, 22);
  assert.deepEqual(gaps[0].set, { messages: 30, unique_authors: 5 });
});

test('applying the repair raises the total and flags the row partial', () => {
  const db = openDb(':memory:');
  const d = dayOf(now());
  insertDay(db, d, 'c1', 8, 3, 0);
  insertHour(db, hourOf(now()), 'c1', 8, 3);
  insertHour(db, hourOf(now()) - HOUR, 'c1', 22, 5);

  const { gaps } = findDayGaps(db, MESSAGE_SPEC);
  apply(db, { messageGaps: gaps, voiceGaps: [], posterGaps: [] });

  const row = dayRow(db, d, 'c1');
  assert.equal(row.messages, 30);
  assert.equal(row.unique_authors, 5, 'distinct count is a floor from the largest hour, never a sum');
  assert.equal(row.partial, 1, 'partial is what makes the live collector accumulate instead of overwrite');

  // Idempotent: a second pass finds nothing, so it is safe to leave in a cron.
  assert.equal(findDayGaps(db, MESSAGE_SPEC).gaps.length, 0);
});

test('repair never lowers a day that is above the sum of its hours', () => {
  const db = openDb(':memory:');
  const d = dayOf(now()) - 3 * DAY;

  // Hourly retention pruned most of this day, so the day row is the only full
  // witness left. Its 42 must survive a run that can only see 12.
  insertDay(db, d, 'c1', 42, 9);
  insertHour(db, d + 5 * HOUR, 'c1', 12, 4);

  assert.equal(findDayGaps(db, MESSAGE_SPEC).gaps.length, 0);
});

test('repair leaves a day with no surviving hours alone', () => {
  const db = openDb(':memory:');
  const d = dayOf(now()) - 400 * DAY;
  insertDay(db, d, 'c1', 17, 4);

  const result = findDayGaps(db, MESSAGE_SPEC);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.unverifiableDays, 1, 'reported as unverifiable rather than silently trusted');
});

test('repair skips a day that is already consistent', () => {
  const db = openDb(':memory:');
  const d = dayOf(now()) - 2 * DAY;
  insertDay(db, d, 'c1', 15, 4);
  insertHour(db, d + 10 * HOUR, 'c1', 9, 4);
  insertHour(db, d + 11 * HOUR, 'c1', 6, 2);

  assert.equal(findDayGaps(db, MESSAGE_SPEC).gaps.length, 0);
});

test('repair separates channels, so one low channel does not mask another', () => {
  const db = openDb(':memory:');
  const d = dayOf(now()) - DAY;
  insertDay(db, d, 'c1', 10, 2);
  insertDay(db, d, 'c2', 5, 2);
  insertHour(db, d + HOUR, 'c1', 10, 2);
  insertHour(db, d + HOUR, 'c2', 9, 3);

  const { gaps } = findDayGaps(db, MESSAGE_SPEC);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].channel_id, 'c2');
  assert.equal(gaps[0].delta, 4);
});

test('repair covers voice days and poster days', () => {
  const db = openDb(':memory:');
  const d = dayOf(now());

  db.run(
    'INSERT INTO voice_day(day_ts, channel_id, seconds, unique_users, partial) VALUES(?,?,?,?,?)',
    d,
    'v1',
    600,
    2,
    0,
  );
  db.run('INSERT INTO voice_hour(hour_ts, channel_id, seconds, unique_users) VALUES(?,?,?,?)', d + HOUR, 'v1', 1200, 3);
  db.run(
    'INSERT INTO voice_hour(hour_ts, channel_id, seconds, unique_users) VALUES(?,?,?,?)',
    d + 2 * HOUR,
    'v1',
    900,
    1,
  );

  db.run('INSERT INTO poster_day(day_ts, posters) VALUES(?,?)', d, 4);
  db.run('INSERT INTO poster_hour(hour_ts, posters) VALUES(?,?)', d + HOUR, 7);

  const voice = findDayGaps(db, {
    dayTable: 'voice_day',
    hourTable: 'voice_hour',
    sumColumn: 'seconds',
    distinctColumn: 'unique_users',
  });
  const posters = findPosterGaps(db);

  assert.equal(voice.gaps.length, 1);
  assert.deepEqual(voice.gaps[0].set, { seconds: 2100, unique_users: 3 });
  assert.equal(posters.length, 1);
  assert.deepEqual(posters[0].set, { posters: 7 });

  apply(db, { messageGaps: [], voiceGaps: voice.gaps, posterGaps: posters });
  assert.equal(db.get('SELECT seconds FROM voice_day WHERE channel_id=?', 'v1').seconds, 2100);
  assert.equal(db.get('SELECT partial FROM voice_day WHERE channel_id=?', 'v1').partial, 1);
  assert.equal(db.get('SELECT posters FROM poster_day WHERE day_ts=?', d).posters, 7);
});

test('repair works against a real file, as the CLI uses it', () => {
  // Guards the part the unit tests cannot: openDb on a path, a transaction
  // across several tables, and closing cleanly afterwards.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'repair-'));
  const dbPath = path.join(dir, 'metrics.db');
  const d = dayOf(now());

  {
    const db = openDb(dbPath);
    insertDay(db, d, 'c1', 2, 1, 1);
    insertHour(db, hourOf(now()), 'c1', 9, 4);
    const { gaps } = findDayGaps(db, MESSAGE_SPEC);
    apply(db, { messageGaps: gaps, voiceGaps: [], posterGaps: [] });
    db.close?.();
  }

  const reopened = openDb(dbPath);
  assert.equal(dayRow(reopened, d, 'c1').messages, 9, 'the write survived the close');
  reopened.close?.();
  rmSync(dir, { recursive: true, force: true });
});

test('buckets stay aligned with the repair window', () => {
  const ts = now();
  assert.equal(dayOf(ts) % DAY, 0);
  assert.equal(hourOf(ts) % HOUR, 0);
});
