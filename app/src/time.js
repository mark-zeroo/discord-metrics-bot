export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86400;

/** All timestamps are integer seconds, all buckets are floor-aligned to UTC. */
export const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;
export const dayOf = (ts) => Math.floor(ts / DAY) * DAY;

export const WINDOWS = new Map([
  ['1d', DAY],
  ['7d', 7 * DAY],
  ['30d', 30 * DAY],
  ['90d', 90 * DAY],
  ['365d', 365 * DAY],
  ['all', null],
]);

export const BUCKETS = new Set(['hour', 'day', 'week', 'month']);

/** ISO-8601 in UTC, no milliseconds — what the model reads. */
export const iso = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
export const isoDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/**
 * Weekly buckets are keyed to Monday so a "games night" weekend lands in one
 * bucket instead of splitting across the ISO boundary.
 */
export function weekStart(ts) {
  const d = new Date(dayOf(ts) * 1000);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return dayOf(ts) - dow * DAY;
}

export function monthStart(ts) {
  const d = new Date(dayOf(ts) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

export function bucketStart(ts, bucket) {
  switch (bucket) {
    case 'hour':
      return hourOf(ts);
    case 'day':
      return dayOf(ts);
    case 'week':
      return weekStart(ts);
    case 'month':
      return monthStart(ts);
    default:
      throw new Error(`unknown bucket ${bucket}`);
  }
}

export function bucketLabel(ts, bucket) {
  switch (bucket) {
    case 'hour':
      return `${iso(ts).slice(0, 13)}:00Z`;
    case 'day':
      return isoDate(ts);
    case 'week':
      return `week of ${isoDate(ts)}`;
    case 'month':
      return isoDate(ts).slice(0, 7);
    default:
      return iso(ts);
  }
}

/**
 * Fields that are a *stock* (a level at a point in time) rather than a *flow*
 * (an amount spent over time).
 *
 * Summing a flow across a bucket is the whole point of a rollup. Summing a stock
 * is nonsense: five days of ~1,103 members became "members: 5507" in a weekly
 * growth bucket, which reads as a server five times its real size. Stocks carry
 * the last observed value in the bucket instead.
 */
const STOCK_FIELDS = new Set(['members']);

/**
 * Roll daily rows up into coarser buckets. Done in JS rather than SQL because
 * strftime week/month semantics are a recurring source of off-by-one bugs and
 * the row counts here are small (<= ~730).
 *
 * Rows must be ascending by ts for stock fields to resolve to the latest value.
 * A null stock never overwrites a real one, so leading backfilled days (which
 * have no headcount) cannot erase the first measured figure.
 */
export function rollup(rows, bucket) {
  if (bucket === 'day') return rows;
  const acc = new Map();
  for (const row of rows) {
    const key = bucketStart(row.ts, bucket);
    let cur = acc.get(key);
    if (!cur) {
      cur = { ts: key, ...zeroLike(row) };
      acc.set(key, cur);
    }
    for (const [k, v] of Object.entries(row)) {
      if (k === 'ts') continue;
      if (typeof v !== 'number') {
        if (!(STOCK_FIELDS.has(k) && v === null && typeof cur[k] === 'number')) cur[k] = v;
        continue;
      }
      if (STOCK_FIELDS.has(k)) cur[k] = v;
      else cur[k] += v;
    }
  }
  return [...acc.values()].sort((a, b) => a.ts - b.ts);
}

function zeroLike(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k !== 'ts' && typeof v === 'number') out[k] = 0;
  }
  return out;
}
