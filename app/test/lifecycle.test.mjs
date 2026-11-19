import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { channelLifecycle } from '../src/api/lifecycle.js';
import { DAY, dayOf, isoDate } from '../src/time.js';
import { makeConfig } from './fixtures.mjs';

const TS = Math.floor(Date.UTC(2026, 10, 11, 18, 0, 0) / 1000);
const TODAY = dayOf(TS);
const day = (n) => TODAY - n * DAY;
const window30 = { label: '30d', seconds: 30 * DAY, all: false };
const cfg = (env = {}) => makeConfig({ PRIVACY_MIN_CELL: '10', ...env });

let nextId = 100;
function channel(db, { name, type = 'text', visible = 1, deleted = null, created = null, parent = null }) {
  const id = String(nextId++);
  db.run(
    `INSERT INTO channel_meta(channel_id, name, type, parent_id, position, nsfw, slowmode,
       overwrite_count, bot_can_view, changed_ts, deleted_ts)
     VALUES(?,?,?,?,?,0,0,0,?,?,?)`,
    id, name, type, parent, 0, visible, TS, deleted,
  );
  if (created !== null) {
    db.run(
      "INSERT INTO structure_change(ts, kind, target_id, target, detail) VALUES(?,?,?,?,?)",
      created, 'channel_created', id, name, type,
    );
  }
  return id;
}

function msgs(db, channelId, dayTs, n) {
  db.run(
    'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
    dayTs, channelId, n, 1,
  );
}

function heartbeat(db, dayTs) {
  db.run('INSERT OR IGNORE INTO collector_day(day_ts, heartbeats, boots, first_ts, last_ts) VALUES(?,1,1,?,?)', dayTs, dayTs, dayTs);
}

function stageOf(out, name) {
  const row = out.channels.find((c) => c.name === name);
  assert.ok(row, `no row for ${name}`);
  return row;
}

function seed(db) {
  for (let d = 0; d <= 30; d += 1) heartbeat(db, day(d));

  // These three have history before the window, so "new" is not on the table and
  // the classification has to come from the trend.
  const growing = channel(db, { name: 'growing' });
  msgs(db, growing, day(45), 10);
  msgs(db, growing, day(20), 100);
  msgs(db, growing, day(5), 200);

  const declining = channel(db, { name: 'declining' });
  msgs(db, declining, day(45), 10);
  msgs(db, declining, day(20), 200);
  msgs(db, declining, day(5), 100);

  const steady = channel(db, { name: 'steady' });
  msgs(db, steady, day(45), 10);
  msgs(db, steady, day(20), 100);
  msgs(db, steady, day(5), 100);

  const dormant = channel(db, { name: 'dormant' });
  msgs(db, dormant, day(40), 50); // before the window; dormant since

  channel(db, { name: 'never-used' });
  channel(db, { name: 'fresh', created: day(5) });
  channel(db, { name: 'invisible', visible: 0 });
  channel(db, { name: 'removed', deleted: day(5) });
  const removedId = '1' + String(nextId - 1);
  msgs(db, removedId, day(6), 30);

  const quiet = channel(db, { name: 'low-volume' });
  msgs(db, quiet, day(3), 5);

  const voice = channel(db, { name: 'lounge', type: 'voice' });
  db.run(
    'INSERT INTO voice_day(day_ts, channel_id, seconds, unique_users, partial) VALUES(?,?,?,?,0)',
    day(2), voice, 36000, 3,
  );

  return { growing, declining, steady, dormant, quiet, voice };
}

test('channels are classified by trend, silence and measurement state', () => {
  const db = openDb(':memory:');
  seed(db);

  const out = channelLifecycle(db, cfg(), { window: window30, ts: TS });
  assert.equal(out.available, true);

  const growing = stageOf(out, 'growing');
  assert.equal(growing.stage, 'growing');
  assert.equal(growing.trend.change, 1);
  assert.equal(growing.messages, 300);

  assert.equal(stageOf(out, 'declining').stage, 'declining');
  assert.equal(stageOf(out, 'steady').stage, 'steady');
  assert.equal(stageOf(out, 'dormant').stage, 'dormant');
  assert.match(stageOf(out, 'dormant').stage_reason, /no activity since/);

  assert.equal(stageOf(out, 'never-used').stage, 'never_used');
  assert.equal(stageOf(out, 'fresh').stage, 'created_unused');
  assert.equal(stageOf(out, 'removed').stage, 'removed');
  assert.equal(stageOf(out, 'low-volume').stage, 'low_volume');
  assert.equal(stageOf(out, 'lounge').stage, 'steady');
  assert.equal(stageOf(out, 'lounge').voice_minutes, 600);
});

test('an invisible channel has no figure at all, rather than zero', () => {
  const db = openDb(':memory:');
  seed(db);
  const out = channelLifecycle(db, cfg(), { window: window30, ts: TS });
  const invisible = stageOf(out, 'invisible');
  assert.equal(invisible.stage, 'unmeasured');
  assert.equal(invisible.activity_known, false);
  assert.equal(invisible.messages, null, 'null, never 0: it was never watched');
  assert.equal(invisible.active_days, null);
  assert.match(invisible.stage_reason, /Not zero — unknown/);

  // It must not be counted as "quiet" either.
  assert.equal(out.by_stage.never_used, 1, 'only the truly unused channel');
});

test('an invisible channel that still has traffic reports the traffic', () => {
  const db = openDb(':memory:');
  seed(db);
  // A stale visibility flag: the collector clearly read this channel.
  const id = channel(db, { name: 'contradiction', visible: 0 });
  msgs(db, id, day(20), 40);
  msgs(db, id, day(4), 40);

  const out = channelLifecycle(db, cfg(), { window: window30, ts: TS });
  const row = stageOf(out, 'contradiction');
  assert.equal(row.visible_to_bot, false);
  assert.equal(row.activity_known, true);
  assert.equal(row.messages, 80, 'traffic beats the flag: it was measured');
  assert.equal(row.stage, 'steady');
});

test('window=all splits the halves at the first data day, not at epoch zero', () => {
  const db = openDb(':memory:');
  for (let d = 0; d <= 90; d += 1) heartbeat(db, day(d));
  const id = channel(db, { name: 'old-then-quiet' });
  // All activity 60 days ago, none since. Under a correct split that is declining
  // or dormant; splitting at 1970 would have called it growing.
  msgs(db, id, day(60), 400);

  const out = channelLifecycle(db, cfg(), {
    window: { label: 'all', seconds: null, all: true },
    ts: TS,
  });
  const row = stageOf(out, 'old-then-quiet');
  assert.notEqual(row.stage, 'growing');
  assert.equal(row.stage, 'dormant');
  assert.equal(out.coverage.window_days, 61);
});

test('rows are capped with explicit truncation, and the stage summary covers all', () => {
  const db = openDb(':memory:');
  for (let d = 0; d <= 30; d += 1) heartbeat(db, day(d));
  for (let i = 0; i < 6; i += 1) {
    const id = channel(db, { name: `busy-${i}` });
    msgs(db, id, day(20), 100 + i);
    msgs(db, id, day(5), 100 + i);
  }

  const out = channelLifecycle(db, cfg(), { window: window30, limit: 3, ts: TS });
  assert.equal(out.rows_returned, 3);
  assert.equal(out.rows_truncated, true);
  assert.equal(out.counts.channels, 6);
  assert.equal(
    Object.values(out.by_stage).reduce((a, b) => a + b, 0),
    6,
    'the summary counts every channel, not the capped list',
  );
  // Sorted by traffic, so the capped list is the part with something at stake.
  assert.equal(out.channels[0].name, 'busy-5');
});

test('coverage says when the collector was not running for the window', () => {
  const db = openDb(':memory:');
  // Only 5 days of heartbeats in a 30-day window.
  for (let d = 0; d <= 4; d += 1) heartbeat(db, day(d));
  channel(db, { name: 'idle' });

  const out = channelLifecycle(db, cfg(), { window: window30, ts: TS });
  assert.equal(out.coverage.days_with_heartbeat, 5);
  assert.match(out.coverage.note, /only 5 of \d+ days/);
  assert.match(out.coverage.note, /lower bound/);
});

test('a channel deleted before the window is still removed, not steady', () => {
  const db = openDb(':memory:');
  for (let d = 0; d <= 90; d += 1) heartbeat(db, day(d));
  const id = channel(db, { name: 'closed-long-ago', deleted: day(80) });
  msgs(db, id, day(85), 40);

  const out = channelLifecycle(db, cfg(), { window: window30, ts: TS });
  const row = stageOf(out, 'closed-long-ago');
  assert.equal(row.stage, 'removed');
  assert.match(row.stage_reason, /deleted before the window/);
});

test('a channel with no structure yet is unavailable, not empty', () => {
  const db = openDb(':memory:');
  const out = channelLifecycle(db, cfg(), { window: window30, ts: TS });
  assert.equal(out.available, false);
  assert.match(out.reason, /structure/);
});

test('duplicate channel names stay distinguishable by id', () => {
  const db = openDb(':memory:');
  const a = channel(db, { name: 'staff-chat', type: 'text' });
  const b = channel(db, { name: 'staff-chat', type: 'voice' });
  msgs(db, a, day(3), 50);
  const out = channelLifecycle(db, cfg(), { window: window30, ts: TS });
  const rows = out.channels.filter((c) => c.name === 'staff-chat');
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map((r) => r.id)), new Set([a, b]));
});

test('creation dates come from structure changes, and are null when unknown', () => {
  const db = openDb(':memory:');
  const known = channel(db, { name: 'known', created: day(10) });
  const unknown = channel(db, { name: 'unknown' });
  msgs(db, known, day(2), 30);
  msgs(db, unknown, day(2), 30);

  const out = channelLifecycle(db, cfg(), { window: window30, ts: TS });
  assert.equal(stageOf(out, 'known').created, `${isoDate(day(10))}T00:00:00Z`);
  assert.equal(stageOf(out, 'unknown').created, null);
  // First observed activity is the fallback for classification.
  assert.equal(stageOf(out, 'unknown').first_activity, `${isoDate(day(2))}T00:00:00Z`);
});
