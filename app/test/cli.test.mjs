// The tagging CLI is the only way an event window gets into the database, so it
// has to work the same way the server does — and it must be obvious which file
// it wrote to. These run it as a subprocess, exactly as `npm run tag` does.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { fileURLToPath } from 'node:url';

import { wallToUtc, isValidZone } from '../src/cli/tag.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli', 'tag.js');

function tag(args, env = {}) {
  // A clean env: no DB_PATH or DATA_DIR leaking in from the developer's shell,
  // and no DISCORD_TOKEN, because tagging must not need one.
  const clean = { PATH: process.env.PATH, ...env };
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    cwd: ROOT,
    env: clean,
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'cli-'));
}

test('tag add writes to $DATA_DIR and says so', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = tag(
    ['add', '--name', 'Spring 5v5 Tourney', '--start', '2026-11-01T18:00', '--end', '2026-11-01T23:00',
      '--kind', 'tournament', '--prize', '6000 tokens', '--participants', '30'],
    { DATA_DIR: dir },
  );

  assert.equal(r.code, 0, r.err);
  // The bug this guards: the DB used to be hardcoded to /data, so a local run
  // wrote somewhere else entirely (or failed with EACCES) while reporting success.
  assert.ok(existsSync(path.join(dir, 'metrics.db')), 'database created under DATA_DIR');
  assert.match(r.out, /db: .*metrics\.db/);
  assert.match(r.out, /window: 5\.0h/);

  const listed = tag(['list'], { DATA_DIR: dir });
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /Spring 5v5 Tourney/);
  assert.match(listed.out, /tournament · 6000 tokens · 30 participants/);
});

test('DB_PATH wins over DATA_DIR, matching the server', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const explicit = path.join(dir, 'custom.db');

  const r = tag(['add', '--name', 'Game night', '--start', '2026-11-02', '--end', '2026-11-02'],
    { DATA_DIR: dir, DB_PATH: explicit });

  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(explicit));
  assert.ok(!existsSync(path.join(dir, 'metrics.db')), 'DATA_DIR was not also written to');
  assert.match(r.out, /24\.0h/, 'a date-only end covers the whole day');
});

test('list on an empty database names the file instead of printing nothing', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = tag(['list'], { DATA_DIR: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /no tags yet in .*metrics\.db/);
});

test('bad input exits non-zero with a usable message', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const backwards = tag(['add', '--name', 'x', '--start', '2026-11-01T20:00', '--end', '2026-11-01T19:00'],
    { DATA_DIR: dir });
  assert.equal(backwards.code, 1);
  assert.match(backwards.err, /--end must be after --start/);

  const noName = tag(['add', '--start', '2026-11-01'], { DATA_DIR: dir });
  assert.equal(noName.code, 1);
  assert.match(noName.err, /--name is required/);

  const missing = tag(['rm', '--id', '9'], { DATA_DIR: dir });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no tag with id 9/);

  const usage = tag(['frobnicate'], { DATA_DIR: dir });
  assert.equal(usage.code, 1);
  assert.match(usage.err, /usage:/);
});

test('rm removes a tag and add assigns increasing ids', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { DATA_DIR: dir };

  tag(['add', '--name', 'A', '--start', '2026-11-01T18:00', '--end', '2026-11-01T20:00'], env);
  const second = tag(['add', '--name', 'B', '--start', '2026-11-02T18:00', '--end', '2026-11-02T20:00'], env);
  assert.match(second.out, /tagged #2 "B"/);

  assert.equal(tag(['rm', '--id', '1'], env).code, 0);
  const listed = tag(['list'], env);
  assert.ok(!listed.out.includes('A'));
  assert.match(listed.out, /# 2 .*B/);
});

test('re-adding the same event updates it instead of duplicating it', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { DATA_DIR: dir };

  const args = ['add', '--name', 'Asia 1v1', '--start', '2026-11-07', '--end', '2026-11-22',
    '--kind', 'tournament', '--notes', 'matches 11/07'];

  assert.match(tag(args, env).out, /tagged #1/);

  // Identical re-run: a no-op, not a twin. A deploy script that tags on every
  // start must be safe to run forever.
  const again = tag(args, env);
  assert.equal(again.code, 0);
  assert.match(again.out, /already tagged as #1 "Asia 1v1" — nothing changed/);

  // Same name and start, corrected note and end date: updated in place, same id.
  const fixed = tag(['add', '--name', 'Asia 1v1', '--start', '2026-11-07', '--end', '2026-11-23',
    '--kind', 'tournament', '--notes', 'matches 11/07, 11/08, 11/14, 11/15, 11/21, 11/22'], env);
  assert.match(fixed.out, /updated #1 "Asia 1v1" \(end, notes\)/);

  const listed = tag(['list', '--tz', 'UTC'], env);
  assert.equal(listed.out.match(/Asia 1v1/g).length, 1, 'still exactly one row');
  assert.ok(listed.out.includes('11/21, 11/22'), 'the corrected note is stored whole');
  assert.ok(!listed.out.includes('matches 11/07\n'), 'the stale note is gone');
});

test('--duplicate inserts anyway when two events really share a name and start', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { DATA_DIR: dir };

  const args = ['add', '--name', 'Game Night', '--start', '2026-11-05T20:00', '--end', '2026-11-05T22:00'];
  tag(args, env);
  const forced = tag([...args, '--duplicate'], env);
  assert.match(forced.out, /tagged #2/);
  assert.equal(tag(['list'], env).out.match(/Game Night/g).length, 2);
});

// ---------------------------------------------------------------- time zones

test('a naive time is read in --tz, not silently in UTC', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 3:30pm Eastern in November is 20:30Z (EST, UTC-5). The old CLI would have
  // stored 15:30Z and measured the wrong five hours of the day.
  const r = tag(
    ['add', '--name', 'HoK 1v1 finals', '--start', '2026-11-14T15:30', '--end', '2026-11-14T20:30',
      '--tz', 'America/New_York'],
    { DATA_DIR: dir },
  );
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2026-11-14T15:30 America\/New_York \(UTC-05:00\)/);
  assert.match(r.out, /2026-11-14T20:30:00Z/);
  assert.doesNotMatch(r.out, /2026-11-14T15:30:00Z/);
});

test('TAG_TZ is the default zone, and --tz overrides it', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const viaEnv = tag(['add', '--name', 'env zone', '--start', '2026-11-14T10:00', '--end', '2026-11-14T11:00'],
    { DATA_DIR: dir, TAG_TZ: 'Asia/Shanghai' });
  assert.equal(viaEnv.code, 0, viaEnv.err);
  assert.match(viaEnv.out, /2026-11-14T02:00:00Z/, 'UTC+8 puts 10:00 at 02:00Z');

  const override = tag(['add', '--name', 'flag zone', '--start', '2026-11-14T10:00', '--end', '2026-11-14T11:00',
    '--tz', 'Asia/Tokyo'], { DATA_DIR: dir, TAG_TZ: 'Asia/Shanghai' });
  assert.match(override.out, /2026-11-14T01:00:00Z/, 'UTC+9 wins over the env default');
});

test('an explicit offset or Z is honoured instead of the zone flag', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 15:30-05:00 and 20:30Z are the same instant, so the end must move past it.
  const r = tag(['add', '--name', 'absolute', '--start', '2026-11-14T15:30-05:00',
    '--end', '2026-11-15T01:30Z', '--tz', 'Asia/Tokyo'], { DATA_DIR: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2026-11-14T20:30:00Z/);
  assert.match(r.out, /2026-11-15T01:30:00Z/);
});

test('a date-only end covers one whole local day', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = tag(['add', '--name', 'game night', '--start', '2026-11-14', '--end', '2026-11-14',
    '--tz', 'America/New_York'], { DATA_DIR: dir });
  assert.equal(r.code, 0, r.err);
  // Midnight EST to midnight EST is 25 hours' worth of UTC in November only if a
  // DST change fell inside the day; on a normal day it is exactly 24h.
  assert.match(r.out, /window: 24\.0h/);
  assert.match(r.out, /2026-11-14T05:00:00Z/);
  assert.match(r.out, /2026-11-15T05:00:00Z/);
});

test('an unknown zone fails loudly instead of defaulting', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = tag(['add', '--name', 'x', '--start', '2026-11-14', '--end', '2026-11-15', '--tz', 'Mars/Olympus'],
    { DATA_DIR: dir });
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown time zone/);
});

test('wallToUtc handles both sides of a DST boundary', () => {
  // 2026-03-08 is the US spring-forward date; 2026-11-01 the fall-back.
  const wall = (iso) => Date.parse(`${iso}Z`) / 1000;

  assert.equal(wallToUtc(wall('2026-01-15T12:00:00'), 'America/New_York'), wall('2026-01-15T17:00:00'));
  assert.equal(wallToUtc(wall('2026-07-15T12:00:00'), 'America/New_York'), wall('2026-07-15T16:00:00'));
  assert.equal(wallToUtc(wall('2026-03-08T12:00:00'), 'America/New_York'), wall('2026-03-08T16:00:00'), 'after the jump');
  assert.equal(wallToUtc(wall('2026-11-01T12:00:00'), 'America/New_York'), wall('2026-11-01T17:00:00'), 'after the fall back');
  // A time in the spring-forward gap does not exist; it must still resolve to a
  // real instant rather than NaN or a wild guess.
  const gap = wallToUtc(wall('2026-03-08T02:30:00'), 'America/New_York');
  assert.ok(Number.isFinite(gap));
  assert.ok(Math.abs(gap - wall('2026-03-08T07:30:00')) <= 3600);

  assert.ok(isValidZone('UTC'));
  assert.ok(isValidZone('Asia/Shanghai'));
  assert.ok(!isValidZone('Not/AZone'));
});
