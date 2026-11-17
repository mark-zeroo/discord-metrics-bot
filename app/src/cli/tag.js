#!/usr/bin/env node
/**
 * Event tagging CLI.
 *
 * The HTTP API is deliberately read-only: there is no POST/PUT/PATCH/DELETE
 * handler anywhere, so a leaked token can read statistics and nothing else.
 * Adding a write route just to support tagging would trade that property away.
 * Tagging therefore happens here, against the same SQLite file the collector
 * writes to; the API only ever reads `event_tag`.
 *
 * Discord's own scheduled events cannot describe the things an actual community
 * runs (a 5v5 tourney with a token prize is not a scheduled event, and its
 * subscriberCount is a guess), so these windows are declared by hand.
 *
 * Usage
 *   npm run tag -- add --name "Spring 5v5 Tourney" \
 *     --start 2026-11-14T15:30 --end 2026-11-14T20:30 \
 *     --tz America/New_York --kind tournament --prize "6000 tokens" --participants 30
 *   npm run tag -- list
 *   npm run tag -- rm --id 3
 *
 *   add is an upsert on (name, start_ts): the same event re-added updates in
 *   place, and an identical re-run changes nothing. --duplicate forces an insert.
 *
 * Time zones
 *   Every timestamp is stored as a UTC epoch second, so the *input* is the only
 *   place a zone can go wrong. A naive time ("2026-11-14T15:30") is interpreted
 *   in --tz, then TAG_TZ, then UTC, and the result is echoed as both UTC and
 *   local time. Silently assuming UTC is how a 3:30pm event ends up stored at
 *   08:30Z and compared against the wrong hours of activity.
 *
 *   An explicit offset ("2026-11-14T15:30-05:00") or "Z" is honoured as-is.
 *
 *   A date-only --end means the whole of that day: end-exclusive, so
 *   --start 2026-11-01 --end 2026-11-01 covers one full local day.
 *
 * Inside Docker the DB lives on the data volume:
 *   docker compose exec metrics node src/cli/tag.js list
 */
import { pathToFileURL } from 'node:url';

import { openDb } from '../db.js';
import { loadStorageConfig } from '../config.js';

const DAY = 86400;

const USAGE = `usage:
  tag add --name <name> --start <when> --end <when>
          [--tz <IANA zone>] [--kind k] [--prize p] [--participants n] [--notes s]
          [--duplicate]
  tag list [--tz <IANA zone>]
  tag rm --id <id>

Re-running add for the same --name and --start updates that tag instead of
creating a second one, so a tag script is safe to run twice. Pass --duplicate
to insert anyway (two events that genuinely share a name and a start).

<when> accepts YYYY-MM-DD, YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS.
Naive times are read in --tz, then $TAG_TZ, then UTC. An explicit
offset (2026-11-14T15:30-05:00) or trailing Z is always honoured.`;

// ------------------------------------------------------------------ time zones

const formatterCache = new Map();

function formatter(tz) {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

export function isValidZone(tz) {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Offset in seconds between the zone's wall clock and UTC at that instant. */
function offsetAt(utcSeconds, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(utcSeconds * 1000))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asIfUtc =
    Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) / 1000;
  return asIfUtc - utcSeconds;
}

/**
 * Turns a wall-clock time in `tz` into a UTC epoch second.
 *
 * Two passes: the first offset guess can be wrong by an hour across a DST
 * boundary, the second pass lands on the right side of it. A time that does not
 * exist (the spring-forward gap) resolves to the instant just after the gap,
 * which is the same thing `date -d` does in GNU coreutils.
 */
export function wallToUtc(wallSeconds, tz) {
  const first = wallSeconds - offsetAt(wallSeconds, tz);
  return wallSeconds - offsetAt(first, tz);
}

function parseWhen(raw, { endOfDay = false, tz = 'UTC' } = {}) {
  if (!raw) throw new Error('missing date');
  const s = String(raw).trim();

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const naive = dateOnly || /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s);
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);

  let seconds;
  if (naive) {
    const [datePart, timePart = '00:00:00'] = s.replace(' ', 'T').split('T');
    const [y, mo, d] = datePart.split('-').map(Number);
    const [h, mi, se] = timePart.split(':').map(Number);
    const wall = Date.UTC(y, mo - 1, d, h, mi, se ?? 0) / 1000;
    seconds = tz === 'UTC' ? wall : wallToUtc(wall, tz);
  } else if (hasOffset) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error(`unparseable date: ${raw}`);
    seconds = Math.floor(ms / 1000);
  } else {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error(`unparseable date: ${raw}`);
    seconds = Math.floor(ms / 1000);
  }

  // End-exclusive: a date-only end means "through the end of that day", which is
  // one whole local day, not one whole UTC day.
  return seconds + (dateOnly && endOfDay ? DAY : 0);
}

const isoUtc = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');

function fmtInZone(ts, tz) {
  if (!tz || tz === 'UTC') return `${isoUtc(ts)} UTC`;
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ts * 1000))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const offset = offsetAt(ts, tz);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute} ${tz} (UTC${sign}${hh}:${mm})`;
}

// ----------------------------------------------------------------- args

// Flags that stand alone. Everything else takes a value, and a bare --flag is an
// error rather than a silent `true`, because "--end" with no date is a typo.
const BOOLEAN_FLAGS = new Set(['duplicate']);

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function resolveZone(flags, env) {
  const tz = flags.tz?.trim() || env.TAG_TZ?.trim() || 'UTC';
  if (!isValidZone(tz)) throw new Error(`unknown time zone: ${tz}`);
  return tz;
}

// ----------------------------------------------------------------- commands

// The columns `add` owns. name and start_ts are the identity, so they are not
// mutable: changing either one describes a different event.
const MUTABLE_FIELDS = ['end_ts', 'kind', 'prize', 'participants', 'notes'];
const FIELD_LABELS = {
  end_ts: 'end',
  kind: 'kind',
  prize: 'prize',
  participants: 'participants',
  notes: 'notes',
};

function add(db, flags, dbPath, env) {
  const name = flags.name?.trim();
  if (!name) throw new Error('--name is required');

  const tz = resolveZone(flags, env);
  const start = parseWhen(flags.start, { tz });
  const end = parseWhen(flags.end, { endOfDay: true, tz });
  if (end <= start) throw new Error('--end must be after --start');

  let participants = null;
  if (flags.participants !== undefined) {
    participants = Number(flags.participants);
    if (!Number.isInteger(participants) || participants < 0) {
      throw new Error('--participants must be a non-negative integer');
    }
  }

  const next = {
    end_ts: end,
    kind: flags.kind?.trim() ?? null,
    prize: flags.prize?.trim() ?? null,
    participants,
    notes: flags.notes?.trim() ?? null,
  };

  // A tag script gets re-run: after a typo, after a date change, from a shell
  // history replay. Matching on name+start is what identifies "the same event"
  // even when its end date or prize is exactly what is being corrected. Without
  // this, the second run inserts a twin and every figure for that event shows up
  // twice in /v1/tags with nothing marking one of them as the stale copy.
  const existing = flags.duplicate
    ? null
    : db.get(
        'SELECT * FROM event_tag WHERE name = ? AND start_ts = ? ORDER BY id LIMIT 1',
        name,
        start,
      );

  if (existing) {
    const changed = MUTABLE_FIELDS.filter((f) => existing[f] !== next[f]);
    if (changed.length === 0) {
      console.log(`already tagged as #${existing.id} "${name}" — nothing changed`);
      return;
    }
    db.run(
      `UPDATE event_tag SET ${changed.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...changed.map((f) => next[f]),
      existing.id,
    );
    console.log(`updated #${existing.id} "${name}" (${changed.map((f) => FIELD_LABELS[f]).join(', ')})`);
  } else {
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO event_tag(name, start_ts, end_ts, kind, prize, participants, notes, created_ts)
       VALUES(?,?,?,?,?,?,?,?)`,
      name,
      start,
      end,
      next.kind,
      next.prize,
      participants,
      next.notes,
      now,
    );
    const row = db.get('SELECT id FROM event_tag ORDER BY id DESC LIMIT 1');
    console.log(`tagged #${row.id} "${name}"`);
  }

  console.log(`  ${fmtInZone(start, tz)}`);
  console.log(`  ${fmtInZone(end, tz)}`);
  console.log(`  window: ${((end - start) / 3600).toFixed(1)}h  (${isoUtc(start)} -> ${isoUtc(end)})`);
  console.log(`  db: ${dbPath}`);
  console.log('  GET /v1/tags will show its uplift against the trailing baseline window.');
}

function list(db, dbPath, flags, env) {
  const tz = resolveZone(flags, env);
  const rows = db.all('SELECT * FROM event_tag ORDER BY start_ts DESC');
  if (rows.length === 0) {
    console.log(`no tags yet in ${dbPath} — add one with: npm run tag -- add --name "..." --start ... --end ...`);
    return;
  }
  for (const r of rows) {
    const meta = [r.kind, r.prize, r.participants !== null ? `${r.participants} participants` : null]
      .filter(Boolean)
      .join(' · ');
    const when = tz === 'UTC' ? `${isoUtc(r.start_ts)} -> ${isoUtc(r.end_ts)} UTC` : `${fmtInZone(r.start_ts, tz)} -> ${fmtInZone(r.end_ts, tz)}`;
    console.log(`#${String(r.id).padStart(2)}  ${when}  ${r.name}`);
    if (meta) console.log(`     ${meta}`);
    if (r.notes) console.log(`     ${r.notes}`);
  }
}

function rm(db, flags) {
  const id = Number(flags.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('--id must be a positive integer');
  const before = db.get('SELECT name FROM event_tag WHERE id = ?', id);
  if (!before) throw new Error(`no tag with id ${id}`);
  db.run('DELETE FROM event_tag WHERE id = ?', id);
  console.log(`removed #${id} "${before.name}"`);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  // Same precedence as the collector (DB_PATH, then DATA_DIR), because the CLI
  // and the server disagreeing about which file they mean is a silent failure:
  // "no tags yet" while the real ones sit in another database.
  const dbPath = loadStorageConfig(env).dbPath;
  const db = openDb(dbPath, { busyTimeoutMs: loadStorageConfig(env).dbBusyTimeoutMs });

  try {
    switch (command) {
      case 'add':
        add(db, parseFlags(rest), dbPath, env);
        return 0;
      case 'list':
        list(db, dbPath, parseFlags(rest), env);
        return 0;
      case 'rm':
        rm(db, parseFlags(rest));
        return 0;
      default:
        console.error(USAGE);
        return 1;
    }
  } finally {
    db.close?.();
  }
}

// Compare URLs, not file:// strings: process.argv[1] is a plain path, so a
// naive string compare breaks under a symlink or a path with spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`tag: ${err.message}`);
    process.exitCode = 1;
  }
}
