import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, ConfigError } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createTokenStore, hashToken, ipAllowed } from '../src/api/auth.js';
import { weekStart, monthStart, rollup, dayOf, hourOf } from '../src/time.js';
import { createIdentity } from '../src/privacy.js';

const BASE_ENV = {
  DISCORD_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccccccc',
  DISCORD_GUILD_ID: '123456789012345678',
};

test('config rejects a missing token', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, DISCORD_TOKEN: '' }), ConfigError);
});

test('config rejects a non-snowflake guild id', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, DISCORD_GUILD_ID: 'not-a-snowflake' }), ConfigError);
});

test('config refuses a public bind unless explicitly acknowledged', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, API_HOST: '0.0.0.0' }), ConfigError);
  const ok = loadConfig({ ...BASE_ENV, API_HOST: '0.0.0.0', ALLOW_PUBLIC_BIND: 'true' });
  assert.equal(ok.api.host, '0.0.0.0');
});

test('config refuses a routable public IP even with the ack flag', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, API_HOST: '203.0.113.5', ALLOW_PUBLIC_BIND: 'true' }),
    ConfigError,
  );
});

test('hmac mode demands a real key', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, PER_MEMBER_COUNTERS: 'hmac', HMAC_KEY: 'short' }),
    ConfigError,
  );
  const ok = loadConfig({
    ...BASE_ENV,
    PER_MEMBER_COUNTERS: 'hmac',
    HMAC_KEY: 'a'.repeat(64),
  });
  assert.equal(ok.privacy.perMemberCounters, 'hmac');
});

test('hmac pseudonyms differ between modes and are stable within one', () => {
  const ephemeral = createIdentity({ mode: 'off', guildId: '1' });
  const stable = createIdentity({ mode: 'hmac', hmacKey: 'k'.repeat(64), guildId: '1' });

  assert.equal(ephemeral.keyFor('42'), ephemeral.keyFor('42'));
  assert.equal(stable.keyFor('42'), stable.keyFor('42'));
  assert.notEqual(ephemeral.keyFor('42'), stable.keyFor('42'));
  // A second ephemeral process must not reproduce the same pseudonym.
  const other = createIdentity({ mode: 'off', guildId: '1' });
  assert.notEqual(ephemeral.keyFor('42'), other.keyFor('42'));
});

test('the token store picks up a new token without a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'tokens.json');
  const write = (ids) =>
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      tokens: ids.map((id) => ({ id, label: id, scopes: ['stats:read'], hash: hashToken(id), revoked_at: null })),
    }));

  write(['tok_one']);
  const store = createTokenStore({ tokensFile: file, reloadIntervalMs: 0 });
  assert.equal(store.tokens.length, 1);

  write(['tok_one', 'tok_two']);
  // Force a distinct mtime; some filesystems have coarse timestamps.
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(file, future, future);

  assert.equal(store.tokens.length, 2);
  assert.deepEqual(store.tokens.map((t) => t.id), ['tok_one', 'tok_two']);

  // A corrupt file must not silently lock everyone out.
  fs.writeFileSync(file, '{ not json');
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(file, later, later);
  assert.equal(store.tokens.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('tokens hash deterministically and to a fixed width', () => {
  const a = hashToken('abc');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, hashToken('abc'));
  assert.notEqual(a, hashToken('abd'));
});

test('ip allowlist handles exact, cidr and mismatch', () => {
  assert.equal(ipAllowed('127.0.0.1', []), true);
  assert.equal(ipAllowed('127.0.0.1', ['127.0.0.1']), true);
  assert.equal(ipAllowed('127.0.0.2', ['127.0.0.1']), false);
  assert.equal(ipAllowed('172.18.0.4', ['172.18.0.0/16']), true);
  assert.equal(ipAllowed('172.19.0.4', ['172.18.0.0/16']), false);
  assert.equal(ipAllowed('::ffff:172.18.0.4', ['172.18.0.0/16']), true);
});

test('buckets align to UTC boundaries', () => {
  const ts = Date.UTC(2026, 4, 14, 13, 37, 12) / 1000; // Thursday
  assert.equal(hourOf(ts), Date.UTC(2026, 4, 14, 13) / 1000);
  assert.equal(dayOf(ts), Date.UTC(2026, 4, 14) / 1000);
  assert.equal(weekStart(ts), Date.UTC(2026, 4, 11) / 1000); // Monday
  assert.equal(monthStart(ts), Date.UTC(2026, 4, 1) / 1000);
});

test('weekly rollup keeps the weekend in one bucket', () => {
  const fri = Date.UTC(2026, 4, 15) / 1000;
  const sat = Date.UTC(2026, 4, 16) / 1000;
  const mon = Date.UTC(2026, 4, 18) / 1000;
  const rows = [
    { ts: fri, messages: 10 },
    { ts: sat, messages: 5 },
    { ts: mon, messages: 1 },
  ];
  const weekly = rollup(rows, 'week');
  assert.equal(weekly.length, 2);
  assert.equal(weekly[0].messages, 15);
  assert.equal(weekly[1].messages, 1);
});

test('rollup sums flows but carries stocks, never summing a headcount', () => {
  // Regression: five days of ~1,103 members became members: 5507 in a weekly
  // growth bucket, i.e. a server five times its real size.
  // Wednesday anchor: five consecutive days stay inside one Mon-Sun week.
  const base = Date.UTC(2026, 4, 13) / 1000;
  const rows = [0, 1, 2, 3, 4].map((i) => ({
    ts: base + i * 86400,
    joins: 2,
    leaves: 1,
    members: 1100 + i,
  }));
  const weekly = rollup(rows, 'week');
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].joins, 10, 'joins are a flow and sum');
  assert.equal(weekly[0].leaves, 5, 'leaves are a flow and sum');
  assert.equal(weekly[0].members, 1104, 'members is a stock: last value in the bucket');
});

test('a null stock does not erase an observed one inside a bucket', () => {
  const base = Date.UTC(2026, 4, 13) / 1000;
  const rows = [
    { ts: base, joins: 1, leaves: 0, members: null },
    { ts: base + 86400, joins: 1, leaves: 0, members: 1100 },
    { ts: base + 86400 * 2, joins: 1, leaves: 0, members: null },
  ];
  const weekly = rollup(rows, 'week');
  assert.equal(weekly[0].members, 1100);
});

test('monthly rollup sums across the month boundary', () => {
  const rows = [
    { ts: Date.UTC(2026, 3, 30) / 1000, messages: 3 },
    { ts: Date.UTC(2026, 4, 1) / 1000, messages: 4 },
  ];
  const monthly = rollup(rows, 'month');
  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].messages, 3);
  assert.equal(monthly[1].messages, 4);
});

test('openDb reports whether the file already existed', () => {
  // A renamed volume or switched mount path is indistinguishable from a healthy
  // start unless the process says so: the schema is created either way.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const file = path.join(dir, 'metrics.db');

  const first = openDb(file);
  assert.equal(first.createdNow, true, 'first open creates the file');
  first.close();

  const second = openDb(file);
  assert.equal(second.createdNow, false, 'reopening an existing file');
  second.close();

  const mem = openDb(':memory:');
  assert.equal(mem.createdNow, true, 'in-memory has no prior history');
  mem.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a weekday floor longer than the baseline is refused at boot', () => {
  // 40 baseline days cannot hold 40 of one weekday: every uplift would refuse for
  // what looks like a data problem rather than a typo.
  assert.throws(
    () => loadConfig({ ...BASE_ENV, EVENT_MATCHED_MIN_DAYS: '40' }),
    /EVENT_MATCHED_MIN_DAYS cannot exceed EVENT_BASELINE_DAYS/,
  );
  const ok = loadConfig({ ...BASE_ENV, EVENT_BASELINE_DAYS: '42', EVENT_MATCHED_MIN_DAYS: '40' });
  assert.equal(ok.analytics.eventMatchedMinDays, 40);
});

test('the anonymity floor cannot be configured away', () => {
  // 1 would turn every guard off while still looking configured.
  assert.throws(() => loadConfig({ ...BASE_ENV, PRIVACY_MIN_CELL: '1' }), ConfigError);
  assert.throws(() => loadConfig({ ...BASE_ENV, PRIVACY_MIN_CELL: '0' }), ConfigError);
  assert.equal(loadConfig({ ...BASE_ENV, PRIVACY_MIN_CELL: '5' }).privacy.minCell, 5);
});

test('core share is bounded so it cannot describe everybody', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, CORE_SHARE: '0.9' }), ConfigError);
  assert.throws(() => loadConfig({ ...BASE_ENV, CORE_SHARE: 'nope' }), ConfigError);
  assert.equal(loadConfig({ ...BASE_ENV, CORE_SHARE: '0.3' }).analytics.coreShare, 0.3);
});
