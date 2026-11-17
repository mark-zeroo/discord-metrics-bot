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
