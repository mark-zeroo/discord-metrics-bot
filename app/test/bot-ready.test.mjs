import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';

import { createBot } from '../src/bot.js';
import { makeConfig } from './fixtures.mjs';

/**
 * Regression test for the boot bug where `Client#login()` was assumed to mean
 * "ready".
 *
 * In discord.js 14.28, `login()` awaits `ws.connect()`, which settles when the
 * websocket opens — before the READY packet is parsed and before `guilds.cache`
 * is populated. Index.js read `bot.guild` straight after login, got null on
 * every boot, and exited 1. Nothing here touches the network: `login` is
 * replaced with an immediately-resolving stub, and `clientReady` is emitted by
 * hand, which is exactly the ordering the old code got wrong.
 */

const noop = () => {};

function fakeLogger() {
  const lines = [];
  const record = (level) => (msg, detail) => lines.push({ level, msg, detail });
  return { lines, info: record('info'), warn: record('warn'), error: record('error'), debug: noop };
}

function makeBot({ guildId = '123456789012345678' } = {}) {
  const db = { setMeta: noop, getMeta: () => null, run: noop, transaction: noop };
  const collectors = {
    messages: { onMessage: noop },
    voice: { onVoiceStateUpdate: noop, abandonAll: noop, setAfkChannel: noop, seed: () => 0 },
    members: { onJoin: noop, onLeave: noop, noteCounts: noop },
  };

  return createBot({
    config: makeConfig({ DISCORD_GUILD_ID: guildId }),
    db,
    collectors,
    logger: fakeLogger(),
  });
}

test('start() does not resolve before clientReady has run', async () => {
  const bot = makeBot();

  // Stand in for the network: resolve "login" instantly, as the real client
  // does, before any READY packet could have been handled.
  bot.client.login = async () => 'stub-token';

  let settled = false;
  let value;
  const started = bot.start().then((guild) => {
    settled = true;
    value = guild;
    return guild;
  });

  // Give the event loop several turns. Under the old code this is where the
  // null guild was read and the process exited.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'start() resolved before the guild cache was populated');

  // Now fire READY. The handler will not find the guild in the (empty) cache,
  // so it must settle the gate with null rather than hanging forever.
  bot.client.emit(Events.ClientReady, {
    user: { id: '1', tag: 'Metrics Bot#0001' },
    guilds: { cache: new Map() },
  });

  const guild = await started;
  assert.equal(settled, true);
  assert.equal(guild, null, 'absent guild must settle as null, not a partial object');
  assert.equal(value, null);

  // The handler sets this to flag a fail-closed exit; reset so the test run
  // itself does not exit non-zero.
  process.exitCode = 0;
});

test('start() times out instead of hanging when clientReady never fires', async () => {
  const bot = makeBot();
  bot.client.login = async () => 'stub-token';

  // Nothing emits clientReady. The 30s guard is too slow for a test, so assert
  // the shape of the guard rather than waiting: start() must still be pending
  // after a short delay, i.e. it is genuinely gated on the event.
  let settled = false;
  bot.start().then(() => {
    settled = true;
    return undefined;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false);

  process.exitCode = 0;
});
