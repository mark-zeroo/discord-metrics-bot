import { BUCKETS, WINDOWS, DAY } from '../time.js';

/**
 * Every query parameter is validated against a closed set. There is no string
 * interpolation into SQL anywhere in this service — the worst a caller can do
 * is ask for an unusual window, and even that is rate limited.
 */
export class ParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParamError';
    this.status = 400;
  }
}

/** Default upper bound for `?top=`; overridden by API_MAX_TOP. */
const MAX_TOP = 10;

export function parseWindow(searchParams, fallback = '30d') {
  const raw = searchParams.get('window') ?? fallback;
  if (!WINDOWS.has(raw)) {
    throw new ParamError(`window must be one of: ${[...WINDOWS.keys()].join(', ')}`);
  }
  const seconds = WINDOWS.get(raw);
  return { label: raw, seconds, all: seconds === null };
}

export function parseBucket(searchParams, fallback = 'day') {
  const raw = searchParams.get('bucket') ?? fallback;
  if (!BUCKETS.has(raw)) {
    throw new ParamError(`bucket must be one of: ${[...BUCKETS].join(', ')}`);
  }
  return raw;
}

export function parseIntParam(searchParams, name, fallback, min, max) {
  const raw = searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,6}$/.test(raw)) throw new ParamError(`${name} must be a positive integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new ParamError(`${name} must be between ${min} and ${max}`);
  return n;
}

export function rejectUnknownParams(searchParams, allowed) {
  for (const key of searchParams.keys()) {
    if (!allowed.includes(key)) throw new ParamError(`unknown parameter: ${key}`);
  }
}

export function maxTop(searchParams, limit = MAX_TOP) {
  return parseIntParam(searchParams, 'top', Math.min(10, limit), 1, limit);
}

/**
 * A closed enum parameter. Used for `cohort` and `bucket`-shaped inputs, so a
 * caller cannot ask for a grouping the query layer has no branch for.
 */
export function parseEnum(searchParams, name, allowed, fallback) {
  const raw = searchParams.get(name) ?? fallback;
  if (!allowed.includes(raw)) {
    throw new ParamError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return raw;
}

/**
 * A comma-separated list of retention periods in days.
 *
 * Sorted and de-duplicated so two spellings of the same request return the same
 * payload, and validated against the set the query layer actually supports — a
 * "periods=45" would otherwise silently compute nothing.
 */
export function parsePeriods(searchParams, allowed, fallback) {
  const raw = searchParams.get('periods');
  if (raw === null) return fallback;
  if (!/^\d{1,3}(,\d{1,3})*$/.test(raw)) {
    throw new ParamError('periods must be a comma-separated list of day counts');
  }
  const list = [...new Set(raw.split(',').map(Number))].sort((a, b) => a - b);
  const bad = list.filter((n) => !allowed.includes(n));
  if (bad.length) {
    throw new ParamError(`periods must be drawn from: ${allowed.join(', ')}`);
  }
  if (list.length === 0 || list.length > allowed.length) {
    throw new ParamError(`periods must name between 1 and ${allowed.length} values`);
  }
  return list;
}

/**
 * A bounded fraction. Only the decimal form is accepted (0.2, not 20), because
 * "share=20" reads as either 20% or twenty times and guessing wrong changes the
 * answer without changing the shape of the request.
 */
export function parseFraction(searchParams, name, fallback, { min, max }) {
  const raw = searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^0?\.\d{1,6}$/.test(raw)) {
    throw new ParamError(`${name} must be a decimal fraction between ${min} and ${max}, e.g. 0.2`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ParamError(`${name} must be between ${min} and ${max}`);
  }
  return n;
}
