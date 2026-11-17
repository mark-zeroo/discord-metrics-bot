/**
 * Shared test fixtures.
 *
 * Config is built by the real loader rather than by hand: a hand-written object
 * silently rots every time a new env var is added (the first symptom is an
 * `undefined` deep inside a query), and it also stops the validator itself from
 * being exercised.
 */
import { loadConfig } from '../src/config.js';

/** Dummy values that satisfy the validators. Nothing here talks to Discord. */
export const TEST_ENV = {
  DISCORD_TOKEN: 'stub-header.stub-payload.stub-signature',
  DISCORD_GUILD_ID: '123456789012345678',
  HMAC_KEY: 'test-hmac-key-that-is-long-enough-to-pass-32b',
};

export function makeConfig(env = {}) {
  return loadConfig({ ...TEST_ENV, ...env });
}
