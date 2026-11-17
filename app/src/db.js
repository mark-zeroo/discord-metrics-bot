import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema notes
 * ------------
 * - Every time-series table is keyed by a floor-aligned integer second, so
 *   range scans are pure index walks and there is no TZ ambiguity.
 * - The flusher writes *deltas* against what this process has already persisted
 *   for a bucket, so a crash mid-interval loses at most one flush window and a
 *   restart adds to an existing bucket instead of replacing it. Overwriting a
 *   partial bucket with a freshly-booted process's counter is what silently
 *   truncated day rows whenever the bot restarted.
 * - No table has a column that can hold a message body. There is nowhere for
 *   content to leak to, which is a stronger guarantee than "we don't write it".
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS message_hour (
     hour_ts        INTEGER NOT NULL,
     channel_id     TEXT    NOT NULL,
     messages       INTEGER NOT NULL DEFAULT 0,
     unique_authors INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (hour_ts, channel_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS message_day (
     day_ts         INTEGER NOT NULL,
     channel_id     TEXT    NOT NULL,
     messages       INTEGER NOT NULL DEFAULT 0,
     unique_authors INTEGER NOT NULL DEFAULT 0,
     partial        INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day_ts, channel_id)
   ) WITHOUT ROWID`,

  // Exact guild-wide distinct-poster counts. unique_authors on message_* is
  // per-channel, so summing it double-counts anyone active in two channels.
  // These tables hold the deduplicated figure as a scalar, which means the
  // honest "how many people actually talked" number is available even when
  // per-member counters are off — no pseudonym is ever stored here.
  `CREATE TABLE IF NOT EXISTS poster_hour (
     hour_ts INTEGER PRIMARY KEY,
     posters INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS poster_day (
     day_ts  INTEGER PRIMARY KEY,
     posters INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS voice_hour (
     hour_ts      INTEGER NOT NULL,
     channel_id   TEXT    NOT NULL,
     seconds      INTEGER NOT NULL DEFAULT 0,
     unique_users INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (hour_ts, channel_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS voice_day (
     day_ts       INTEGER NOT NULL,
     channel_id   TEXT    NOT NULL,
     seconds      INTEGER NOT NULL DEFAULT 0,
     unique_users INTEGER NOT NULL DEFAULT 0,
     partial      INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day_ts, channel_id)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS growth_hour (
     hour_ts INTEGER PRIMARY KEY,
     joins   INTEGER NOT NULL DEFAULT 0,
     leaves  INTEGER NOT NULL DEFAULT 0,
     members INTEGER,
     bots    INTEGER
   )`,

  `CREATE TABLE IF NOT EXISTS growth_day (
     day_ts  INTEGER PRIMARY KEY,
     joins   INTEGER NOT NULL DEFAULT 0,
     leaves  INTEGER NOT NULL DEFAULT 0,
     members INTEGER,
     bots    INTEGER,
     partial INTEGER NOT NULL DEFAULT 0
   )`,

  // Retroactive join curve reconstructed from member.joinedAt on first run.
  // This is the only metric that beats Discord's own Server Insights.
  `CREATE TABLE IF NOT EXISTS growth_backfill (
     day_ts INTEGER PRIMARY KEY,
     joins  INTEGER NOT NULL,
     source TEXT NOT NULL DEFAULT 'joined_at'
   )`,

  `CREATE TABLE IF NOT EXISTS snapshot (
     ts       INTEGER PRIMARY KEY,
     members  INTEGER,
     bots     INTEGER,
     online   INTEGER,
     boosts   INTEGER,
     tier     INTEGER,
     channels INTEGER,
     roles    INTEGER
   )`,

  `CREATE TABLE IF NOT EXISTS guild_event (
     event_id    TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     start_ts    INTEGER,
     end_ts      INTEGER,
     user_count  INTEGER,
     status      TEXT,
     observed_ts INTEGER NOT NULL
   ) WITHOUT ROWID`,

  // Operator-declared event windows (tournaments, game nights, collab nights).
  // Discord scheduled events cannot express these: a 5v5 tourney is not a
  // scheduled event, and turnout here is the real participant count rather than
  // a subscriber estimate. Written only by `npm run tag` — the HTTP API stays
  // read-only, which is a property worth more than the convenience of a POST.
  `CREATE TABLE IF NOT EXISTS event_tag (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     name         TEXT    NOT NULL,
     start_ts     INTEGER NOT NULL,
     end_ts       INTEGER NOT NULL,
     kind         TEXT,
     prize        TEXT,
     participants INTEGER,
     notes        TEXT,
     created_ts   INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS channel_name (
     channel_id TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     updated_ts INTEGER NOT NULL
   ) WITHOUT ROWID`,

  // Per-member counters are only ever written when PER_MEMBER_COUNTERS=hmac.
  // user_hmac is HMAC-SHA256(user id) under a key that lives only in env.
  `CREATE TABLE IF NOT EXISTS member_hour (
     hour_ts   INTEGER NOT NULL,
     user_hmac TEXT    NOT NULL,
     messages  INTEGER NOT NULL DEFAULT 0,
     voice_s   INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (hour_ts, user_hmac)
   ) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS api_audit (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     ts       INTEGER NOT NULL,
     token_id TEXT,
     route    TEXT NOT NULL,
     query    TEXT,
     status   INTEGER NOT NULL,
     ms       INTEGER NOT NULL,
     peer     TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS voice_active (
     session_id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_key   TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     started_ts INTEGER NOT NULL
   )`,

  // ---------------------------------------------------------------- structure
  // Server *configuration*, which is not the same thing as activity and needs no
  // permissions to read: the Guilds intent delivers every channel with its
  // overwrites and every role with its permission bitfield. Permissions gate
  // actions and message content, not guild metadata.
  //
  // Two deliberate omissions. There is no topic column, because topics collect
  // webhook URLs and invite links and are the single most likely place for a
  // secret to arrive through a channel that is otherwise just a name. And there
  // is no member list per role: member_count is a number, never the members.

  // deleted_ts is kept rather than deleting rows, so "this channel existed and
  // was removed on <date>" survives. Current-state queries filter IS NULL.
  `CREATE TABLE IF NOT EXISTS channel_meta (
     channel_id      TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     type            TEXT NOT NULL,
     parent_id       TEXT,
     position        INTEGER,
     nsfw            INTEGER,
     slowmode        INTEGER,
     overwrite_count INTEGER NOT NULL DEFAULT 0,
     bot_can_view    INTEGER,
     changed_ts      INTEGER NOT NULL,
     deleted_ts      INTEGER
   ) WITHOUT ROWID`,

  // permissions is the raw Discord bitfield as a decimal string. SQLite integers
  // are signed 64-bit and Discord's high permission bits live in the top of that
  // range, so a string round-trips exactly where a cast could silently flip sign.
  `CREATE TABLE IF NOT EXISTS role_meta (
     role_id      TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     position     INTEGER,
     color        INTEGER,
     hoist        INTEGER,
     managed      INTEGER,
     mentionable  INTEGER,
     permissions  TEXT NOT NULL,
     member_count INTEGER,
     changed_ts   INTEGER NOT NULL,
     deleted_ts   INTEGER
   ) WITHOUT ROWID`,

  // Structural changes as events: a channel created the week a tournament opens
  // explains a traffic jump in a way a static snapshot never can.
  `CREATE TABLE IF NOT EXISTS structure_change (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     ts        INTEGER NOT NULL,
     kind      TEXT    NOT NULL,
     target_id TEXT,
     target    TEXT,
     detail    TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_structure_change_ts ON structure_change(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_channel_meta_deleted ON channel_meta(deleted_ts)`,

  `CREATE INDEX IF NOT EXISTS idx_message_hour_ts ON message_hour(hour_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_message_day_ts  ON message_day(day_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_voice_hour_ts   ON voice_hour(hour_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_voice_day_ts    ON voice_day(day_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_ts        ON api_audit(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_event_tag_start ON event_tag(start_ts)`,
  `CREATE INDEX IF NOT EXISTS idx_member_hour_ts  ON member_hour(hour_ts)`,
];

/**
 * `busyTimeoutMs` is how long SQLite waits on a locked file before returning
 * SQLITE_BUSY. It matters here because the API reads while the collector writes:
 * without a wait, a flush landing mid-request surfaces to the model as `busy`
 * instead of just taking a few milliseconds longer.
 *
 * Note the pragma spelling: `busy_timeout`, not `busytimeout`. The wrong name is
 * accepted silently and applies nothing.
 */
export function openDb(dbPath, { busyTimeoutMs = 5000 } = {}) {
  if (dbPath !== ':memory:') {
    // The umask is the only thing that governs modes for files SQLite creates itself.
    // This database file is chmod 0600 below, but `-wal` and `-shm` are created by
    // SQLite from 0666 & ~umask, which on a default 022 host leaves 0644 — a
    // world-readable copy of every recent write sitting next to a 0600 database. Set
    // here rather than in the entry point so it holds for every caller of openDb:
    // the collector, `docker compose exec`, and bare-metal runs alike.
    process.umask(0o027);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o750 });
  }

  // Whether the file already existed decides between "continuing my history" and
  // "silently started a new one", which is by far the most expensive thing to get
  // wrong here: a renamed volume or a switched mount path looks identical from
  // inside the process otherwise. Reported once at startup.
  const existedBefore = dbPath === ':memory:' ? false : fs.existsSync(dbPath);

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL'); // WAL + NORMAL: survives process crash
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA trusted_schema = OFF');
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);

  for (const stmt of SCHEMA) db.exec(stmt);

  if (dbPath !== ':memory:') {
    // Owner-only. The container user is the only reader that matters.
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* best effort, e.g. on a bind mount owned elsewhere */
    }
  }

  return {
    raw: db,
    path: dbPath,
    createdNow: !existedBefore,

    get(sql, ...params) {
      return db.prepare(sql).get(...params);
    },
    all(sql, ...params) {
      return db.prepare(sql).all(...params);
    },
    run(sql, ...params) {
      return db.prepare(sql).run(...params);
    },

    /** Same connection, so nested calls are safe; SQLite has no real nesting. */
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    },

    getMeta(key) {
      return this.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
    },
    setMeta(key, value) {
      this.run(
        'INSERT INTO meta(key, value) VALUES(?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        String(value),
      );
    },

    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// Table names are interpolated, so they stay hard-coded: never derived from input.
const DAY_PARTIAL_TABLES = ['message_day', 'voice_day', 'growth_day'];

/**
 * A day is partial when the process observing it did not see it from the start.
 *
 * The collectors set that flag when they write a day row, which only reaches rows
 * this process actually rewrites — and a row is only rewritten when new traffic
 * arrives for it. So a day whose rows were first written by a process that booted
 * the day before stays unflagged no matter how often the bot restarts afterwards.
 * That is not hypothetical: on 2026-11-14 the bot booted 17 times and recorded 41
 * messages, yet partial_days listed only the install day, because everything
 * before the first boot of the day was written by the previous day's process.
 *
 * Marking at boot repairs the rows that already exist; the collectors' own
 * isPartialDay covers the ones that do not exist yet.
 */
export function markDayPartial(db, dayTs) {
  let updated = 0;
  for (const table of DAY_PARTIAL_TABLES) {
    const before = db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE day_ts = ? AND partial = 0`, dayTs);
    db.run(`UPDATE ${table} SET partial = 1 WHERE day_ts = ? AND partial = 0`, dayTs);
    updated += before?.n ?? 0;
  }
  return updated;
}
