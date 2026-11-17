// The database is the only thing this service stores, and it holds channel names,
// member pseudonyms and per-hour counts. Its mode bits are part of the privacy story,
// so they get a test: `metrics.db` is chmod 0600, but SQLite creates the `-wal` and
// `-shm` siblings itself, and those follow 0666 & ~umask. With a default 022 umask
// that left two world-readable files next to a private one, which is the same data in
// a different filename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';

const modeOf = (p) => statSync(p).mode & 0o777;

test('database, sidecars and their directory are not world-accessible', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  const dataDir = path.join(dir, 'data');
  const db = openDb(path.join(dataDir, 'metrics.db'));
  try {
    // A write is what makes SQLite create -wal and -shm.
    db.raw.exec('CREATE TABLE scratch (x INTEGER)');
    db.raw.exec('INSERT INTO scratch VALUES (1)');

    assert.equal(modeOf(dataDir) & 0o007, 0, `data dir is world-accessible: ${modeOf(dataDir).toString(8)}`);
    for (const name of ['metrics.db', 'metrics.db-wal', 'metrics.db-shm']) {
      const mode = modeOf(path.join(dataDir, name));
      assert.equal(mode & 0o007, 0, `${name} is world-accessible: 0${mode.toString(8)}`);
      assert.equal(mode & 0o700, 0o600, `${name} should be readable and writable by its owner only: 0${mode.toString(8)}`);
    }
  } finally {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb lowers the umask, so later writes inherit it too', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  const db = openDb(path.join(dir, 'metrics.db'));
  try {
    assert.equal(process.umask(), 0o027);
  } finally {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
