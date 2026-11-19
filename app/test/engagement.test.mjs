import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import * as Q from '../src/api/queries.js';
import { STATUS } from '../src/api/suppression.js';
import { DAY, hourOf } from '../src/time.js';
import { makeConfig, seedConcentration } from './fixtures.mjs';

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

const now = () => Math.floor(Date.now() / 1000);

// --------------------------------------------------------------- exact posters

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
