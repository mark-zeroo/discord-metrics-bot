/**
 * Shared test fixtures.
 *
 * Config is built by the real loader rather than by hand: a hand-written object
 * silently rots every time a new env var is added (the first symptom is an
 * `undefined` deep inside a query), and it also stops the validator itself from
 * being exercised.
 */
import { loadConfig } from '../src/config.js';
import { DAY, hourOf } from '../src/time.js';

const now = () => Math.floor(Date.now() / 1000);

/** Dummy values that satisfy the validators. Nothing here talks to Discord. */
export const TEST_ENV = {
  DISCORD_TOKEN: 'stub-header.stub-payload.stub-signature',
  DISCORD_GUILD_ID: '123456789012345678',
  HMAC_KEY: 'test-hmac-key-that-is-long-enough-to-pass-32b',
};

/**
 * A pinned message distribution: ten active members, 100/50/20/10/5/3/2/1/1/1
 * messages in one hour, plus a zero-message row that reaches back to the edge of
 * the 30-day window and a snapshot of 100 humans.
 *
 * Shared by the engagement and summary suites: they inspect the same shape from
 * two angles, and a second copy of this is how two tests start disagreeing about
 * what "ten active members" means.
 */
export function seedConcentration(db) {
  const ts = hourOf(now());
  const counts = [100, 50, 20, 10, 5, 3, 2, 1, 1, 1];
  counts.forEach((n, i) => {
    db.run(
      'INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)',
      ts,
      `m${String(i).padStart(2, '0')}`,
      n,
    );
  });
  db.run(
    'INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s) VALUES(?,?,0,0)',
    hourOf(now() - 30 * DAY),
    'coverage',
  );
  db.run(
    'INSERT INTO snapshot(ts, members, bots, online, boosts, tier, channels, roles) VALUES(?,?,?,?,?,?,?,?)',
    now(), 100, 5, 10, 1, 0, 10, 5,
  );
  return counts;
}

export function makeConfig(env = {}) {
  return loadConfig({ ...TEST_ENV, ...env });
}
