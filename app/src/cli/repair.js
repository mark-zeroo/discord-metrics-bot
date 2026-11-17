#!/usr/bin/env node
/**
 * Bucket repair CLI.
 *
 * Why this exists: the collector once persisted each flush as an absolute value
 * taken from in-memory counters that started at zero on every boot. A restart
 * inside a day therefore rewrote that day's row down to "messages seen since
 * this boot", while the hourly rows for the same day kept the real figures. The
 * day row ended up *lower* than the hours that compose it, which is impossible
 * for real data and quietly deflates every daily total and every event baseline
 * that reads `*_day`.
 *
 * The collector now adds deltas and accumulates into any row already flagged
 * `partial`, so this cannot happen again (see src/collectors/messages.js). This
 * tool fixes the rows written before that change, and stays useful afterwards as
 * a consistency check: hourly rows are the finest granularity that exists, so
 * where they survive they are the best evidence of what a day contained.
 *
 * Rules, in order of importance:
 *   1. Only ever raise a value. Hourly rows are pruned before daily rows, so an
 *      hour sum *below* the day value just means part of the day is no longer
 *      covered at hourly resolution — not that the day is wrong.
 *   2. A day's message/voice total is at least the sum of its hours.
 *   3. A day's distinct-author (or distinct-user) count is at least the largest
 *      single hour it saw. Distinct counts are unions, not sums; adding them
 *      would be wrong in the other direction.
 *   4. Repaired day rows are marked `partial = 1`, because a day that needed
 *      repair demonstrably was not observed continuously. That flag is also what
 *      makes the live collector *accumulate* into the row instead of replacing
 *      it on the next flush, so the correction is not undone minutes later.
 *
 * Usage
 *   npm run repair                    # report only, writes nothing
 *   npm run repair -- --apply         # write the corrections
 *   npm run repair -- --json          # machine-readable report
 *   npm run repair -- --db /tmp/x.db  # inspect a copy
 *
 * Inside Docker:
 *   docker compose exec metrics node src/cli/repair.js --apply
 */
import { pathToFileURL } from 'node:url';

import { openDb } from '../db.js';
import { loadStorageConfig } from '../config.js';
import { DAY, isoDate } from '../time.js';

const USAGE = `usage:
  repair [--apply] [--db <path>] [--json]

  (no flags)   report inconsistencies, change nothing
  --apply      write the corrections
  --db <path>  inspect a specific database file (default: $DB_PATH, then $DATA_DIR/metrics.db)
  --json       emit the report as JSON`;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'apply' || key === 'json') {
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

/**
 * Compare a daily table against its hourly sibling.
 *
 * Table and column names are fixed literals chosen by the caller, never taken
 * from argv, so every statement here stays a constant string.
 */
export function findDayGaps(db, { dayTable, hourTable, sumColumn, distinctColumn }) {
  const hourly = db.all(
    `SELECT (hour_ts / ${DAY}) * ${DAY} AS day_ts,
            channel_id,
            SUM(${sumColumn}) AS hour_total,
            MAX(${distinctColumn}) AS hour_distinct,
            COUNT(*) AS hours_present
       FROM ${hourTable}
      GROUP BY day_ts, channel_id`,
  );

  const dayRows = db.all(
    `SELECT day_ts, channel_id, ${sumColumn} AS day_total,
            ${distinctColumn} AS day_distinct, partial
       FROM ${dayTable}`,
  );
  const dayIndex = new Map(dayRows.map((r) => [`${r.day_ts}:${r.channel_id}`, r]));

  const gaps = [];
  for (const row of hourly) {
    const day = dayIndex.get(`${row.day_ts}:${row.channel_id}`);
    if (!day) continue; // hours without a day row: rebuilt on the next flush
    const total = Math.max(day.day_total, row.hour_total);
    const distinct = Math.max(day.day_distinct, row.hour_distinct);
    if (total === day.day_total && distinct === day.day_distinct) continue;

    gaps.push({
      day_ts: row.day_ts,
      date: isoDate(row.day_ts),
      channel_id: row.channel_id,
      stored: day.day_total,
      from_hours: row.hour_total,
      delta: total - day.day_total,
      stored_distinct: day.day_distinct,
      distinct_from_hours: row.hour_distinct,
      hours_present: row.hours_present,
      partial: day.partial,
      set: { [sumColumn]: total, [distinctColumn]: distinct },
    });
  }

  gaps.sort((a, b) => b.day_ts - a.day_ts || b.delta - a.delta);

  const hourlyDays = new Set(hourly.map((r) => r.day_ts));
  const allDays = new Set(dayRows.map((r) => r.day_ts));
  const unverifiableDays = [...allDays].filter((d) => !hourlyDays.has(d)).length;
  return { gaps, unverifiableDays };
}

/** poster_day is guild-wide; the largest hourly value is a safe floor for it. */
export function findPosterGaps(db) {
  const rows = db.all(
    `SELECT (hour_ts / ${DAY}) * ${DAY} AS day_ts, MAX(posters) AS hour_max, COUNT(*) AS hours_present
       FROM poster_hour
      GROUP BY day_ts`,
  );
  const gaps = [];
  for (const row of rows) {
    const day = db.get('SELECT posters FROM poster_day WHERE day_ts = ?', row.day_ts);
    if (!day) continue;
    if (row.hour_max <= day.posters) continue;
    gaps.push({
      day_ts: row.day_ts,
      date: isoDate(row.day_ts),
      stored: day.posters,
      from_hours: row.hour_max,
      delta: row.hour_max - day.posters,
      hours_present: row.hours_present,
      set: { posters: row.hour_max },
    });
  }
  gaps.sort((a, b) => b.day_ts - a.day_ts);
  return gaps;
}

const DAY_TABLES = {
  message_day: ['messages', 'unique_authors'],
  voice_day: ['seconds', 'unique_users'],
  poster_day: ['posters'],
};
const PARTIAL_TABLES = new Set(['message_day', 'voice_day']);

export function apply(db, { messageGaps, voiceGaps, posterGaps }) {
  const work = [
    ['message_day', messageGaps],
    ['voice_day', voiceGaps],
    ['poster_day', posterGaps],
  ];

  db.transaction(() => {
    for (const [table, gaps] of work) {
      const columns = DAY_TABLES[table];
      for (const g of gaps) {
        const assignments = columns.map((c) => `${c} = ?`).join(', ');
        const values = columns.map((c) => g.set[c]);
        // partial = 1 is not cosmetic: it is what tells the live collector to add
        // to this row instead of overwriting it with a since-boot counter.
        const partialSet = PARTIAL_TABLES.has(table) ? ', partial = 1' : '';
        if (table === 'poster_day') {
          db.run(`UPDATE poster_day SET ${assignments}${partialSet} WHERE day_ts = ?`, ...values, g.day_ts);
        } else {
          db.run(
            `UPDATE ${table} SET ${assignments}${partialSet} WHERE day_ts = ? AND channel_id = ?`,
            ...values,
            g.day_ts,
            g.channel_id,
          );
        }
      }
    }
  });
}

function printTable(title, gaps, unit) {
  if (gaps.length === 0) {
    console.log(`${title}: consistent`);
    return 0;
  }
  const withChannel = gaps.some((g) => g.channel_id !== undefined);
  const withDistinct = gaps.some((g) => g.stored_distinct !== undefined && g.stored_distinct !== g.distinct_from_hours);
  console.log(`${title}: ${gaps.length} row(s) lower than their hourly data`);
  console.log(
    `  ${'day'.padEnd(10)}  ${withChannel ? `${'channel'.padEnd(20)}  ` : ''}${'stored'.padStart(9)}  ${'hours'.padStart(9)}  ${'delta'.padStart(7)}${withDistinct ? `  ${'distinct'.padStart(16)}` : ''}`,
  );
  let delta = 0;
  for (const g of gaps) {
    delta += g.delta;
    const channel = withChannel ? `${String(g.channel_id).padEnd(20)}  ` : '';
    const distinct =
      withDistinct && g.stored_distinct !== undefined
        ? `  ${`${g.stored_distinct} -> ${g.distinct_from_hours}`.padStart(16)}`
        : '';
    console.log(
      `  ${g.date.padEnd(10)}  ${channel}${String(g.stored).padStart(9)}  ${String(g.from_hours).padStart(9)}  ${String(g.delta).padStart(7)}${distinct}`,
    );
  }
  console.log(`  total recovered: ${delta} ${unit}`);
  return delta;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const flags = parseFlags(argv);
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  const storage = loadStorageConfig(env);
  const dbPath = flags.db ?? storage.dbPath;
  const db = openDb(dbPath, { busyTimeoutMs: storage.dbBusyTimeoutMs });

  try {
    const messages = findDayGaps(db, {
      dayTable: 'message_day',
      hourTable: 'message_hour',
      sumColumn: 'messages',
      distinctColumn: 'unique_authors',
    });
    const voice = findDayGaps(db, {
      dayTable: 'voice_day',
      hourTable: 'voice_hour',
      sumColumn: 'seconds',
      distinctColumn: 'unique_users',
    });
    const posters = findPosterGaps(db);

    const report = {
      db: dbPath,
      applied: Boolean(flags.apply),
      messages: messages.gaps,
      voice: voice.gaps,
      posters,
      unverifiable_days: {
        messages: messages.unverifiableDays,
        note: 'Day rows with no hourly rows left are pruned beyond hourly retention and cannot be checked.',
      },
    };

    if (flags.apply) apply(db, { messageGaps: messages.gaps, voiceGaps: voice.gaps, posterGaps: posters });

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    console.log(`db: ${dbPath}`);
    printTable('message_day', messages.gaps, 'messages');
    console.log('');
    printTable('voice_day', voice.gaps, 'member-seconds');
    console.log('');
    printTable('poster_day', posters, 'posters');
    console.log('');

    if (report.unverifiable_days.messages > 0) {
      console.log(
        `${report.unverifiable_days.messages} message day row(s) predate hourly retention and were not checked.`,
      );
    }

    const total = messages.gaps.length + voice.gaps.length + posters.length;
    if (total === 0) {
      console.log('nothing to repair.');
      return 0;
    }
    if (flags.apply) {
      console.log(`repaired ${total} row(s). Repaired day rows are flagged partial = 1.`);
    } else {
      console.log(`dry run: ${total} row(s) would change. Re-run with --apply to write them.`);
    }
    return 0;
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
    console.error(`repair: ${err.message}`);
    process.exitCode = 1;
  }
}
