import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import { openDb } from '../src/db.js';
import { silentLogger } from '../src/log.js';
import { dayOf } from '../src/time.js';
import {
  ROLES_META_KEY,
  buildAccessEmbed,
  buildActivityEmbed,
  buildGrowthEmbed,
  buildSummaryEmbed,
  buildVoiceEmbed,
  canRunStats,
  createCommandHandler,
  definitions,
  loadAllowedRoles,
  registerCommands,
  saveAllowedRoles,
} from '../src/commands.js';
import { makeConfig } from './fixtures.mjs';

let db;
let config;

const ADMIN_ROLE = '900000000000000001';
const STAFF_ROLE = '900000000000000002';

before(() => {
  db = openDb(':memory:');
  config = makeConfig({ PER_MEMBER_COUNTERS: 'off', LOG_LEVEL: 'error' });

  const now = Math.floor(Date.now() / 1000);
  const today = dayOf(now);
  db.setMeta('guild.id', '1');
  db.setMeta('guild.name', 'HPNinjaz');
  // Deliberately lower than the snapshot below: this is the frozen install-day
  // headcount, and the caveat test depends on the two disagreeing.
  db.setMeta('backfill.members', '800');

  db.run(
    `INSERT INTO snapshot(ts, members, bots, online, boosts, tier, channels, roles)
     VALUES(?,?,?,?,?,?,?,?)`,
    now, 812, 12, 210, 6, 1, 34, 22,
  );
  db.run('INSERT INTO channel_name(channel_id, name, updated_ts) VALUES(?,?,?)', '10', 'general', now);
  db.run(
    'INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial) VALUES(?,?,?,?,0)',
    today, '10', 420, 55,
  );
  db.run(
    'INSERT INTO voice_day(day_ts, channel_id, seconds, unique_users, partial) VALUES(?,?,?,?,0)',
    today, '20', 7200, 8,
  );
  db.run(
    'INSERT INTO growth_day(day_ts, joins, leaves, members, bots, partial) VALUES(?,?,?,?,?,0)',
    today, 5, 2, 812, 12,
  );
  db.run('INSERT INTO growth_backfill(day_ts, joins) VALUES(?,?)', today - 86400 * 3, 4);
});

after(() => db?.close());

/* ------------------------------------------------------------------ *
 * definitions
 * ------------------------------------------------------------------ */

test('command definitions cover the four stats views and an access command', () => {
  const commands = definitions();
  const names = commands.map((c) => c.name);
  assert.deepEqual(names, ['stats', 'stats-access']);

  const stats = commands.find((c) => c.name === 'stats');
  assert.deepEqual(
    stats.options.map((o) => o.name),
    ['summary', 'activity', 'growth', 'voice'],
  );
  // Unrestricted by default: Discord must not hide it before anyone configures it.
  assert.equal(stats.default_member_permissions, undefined);
  assert.equal(stats.dm_permission, false);

  const access = commands.find((c) => c.name === 'stats-access');
  assert.deepEqual(
    access.options.map((o) => o.name),
    ['list', 'add', 'remove', 'clear'],
  );
  // Hides the command from non-admins as a courtesy; the handler re-checks.
  // Compare against the real bitfield: hardcoding 8 here asserted "Administrator"
  // while the code asks for Manage Server (32), and the test passed for the wrong reason.
  assert.equal(access.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});

test('every window choice is a real window', () => {
  const stats = definitions().find((c) => c.name === 'stats');
  const summary = stats.options.find((o) => o.name === 'summary');
  const window = summary.options.find((o) => o.name === 'window');
  const values = window.choices.map((c) => c.value);
  assert.deepEqual(values, ['1d', '7d', '30d', '90d', 'all']);
});

/* ------------------------------------------------------------------ *
 * allowlist + permission decision
 * ------------------------------------------------------------------ */

test('allowlist round-trips, dedupes and survives corruption', () => {
  saveAllowedRoles(db, [STAFF_ROLE, STAFF_ROLE]);
  assert.deepEqual(loadAllowedRoles(db), [STAFF_ROLE]);

  db.setMeta(ROLES_META_KEY, 'not json at all');
  // Corrupt state must fail open, or a bad byte locks everyone out permanently.
  assert.deepEqual(loadAllowedRoles(db), []);

  db.setMeta(ROLES_META_KEY, JSON.stringify({ nope: true }));
  assert.deepEqual(loadAllowedRoles(db), []);

  saveAllowedRoles(db, []);
  assert.deepEqual(loadAllowedRoles(db), []);
});

test('an empty allowlist means unrestricted', () => {
  assert.deepEqual(canRunStats({ allowed: [], roleIds: [], hasManageGuild: false }), {
    ok: true,
    reason: 'unrestricted',
  });
});

test('a populated allowlist requires a matching role', () => {
  const allowed = [STAFF_ROLE];
  assert.equal(canRunStats({ allowed, roleIds: [STAFF_ROLE], hasManageGuild: false }).ok, true);
  assert.equal(canRunStats({ allowed, roleIds: ['other'], hasManageGuild: false }).ok, false);
  assert.equal(canRunStats({ allowed, roleIds: [], hasManageGuild: false }).ok, false);
});

test('Manage Server overrides the allowlist so it can always be undone', () => {
  const verdict = canRunStats({ allowed: [STAFF_ROLE], roleIds: [], hasManageGuild: true });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, 'manage_guild');
});

/* ------------------------------------------------------------------ *
 * embed builders
 * ------------------------------------------------------------------ */

test('summary embed carries the headline numbers', () => {
  const data = {
    window: '30d',
    guild: { name: 'HPNinjaz', members: 812, online: 210, boosts: 6, tier: 1 },
    totals: { messages: 420, voice_seconds: 7200, joins: 5, leaves: 2, unique_posters: 55 },
    busiest_channel: { id: '10', name: 'general', messages: 420 },
    caveats: ['Coverage note.'],
  };
  const json = buildSummaryEmbed(data).toJSON();
  const value = (name) => json.fields.find((f) => f.name === name)?.value;

  assert.match(json.title, /HPNinjaz — 30d/);
  assert.equal(value('Members'), '812');
  assert.equal(value('Messages'), '420');
  assert.equal(value('Voice'), '2.0 h');
  assert.equal(value('Joins / leaves'), '5 / 2');
  assert.match(value('Busiest channel'), /<#10> — 420/);
  assert.equal(json.footer.text, 'Coverage note.');
});

test('summary embed falls back to avg daily posters and tolerates empty data', () => {
  const withAvg = buildSummaryEmbed({
    window: '7d',
    guild: {},
    totals: { unique_posters: null, avg_daily_posters: 12.5 },
    busiest_channel: null,
  }).toJSON();
  assert.equal(withAvg.fields.find((f) => f.name === 'Posters').value, '**12.5** avg/day');
  assert.equal(withAvg.fields.find((f) => f.name === 'Busiest channel').value, 'None recorded');

  // No payload at all must not throw: a fresh install has no rows.
  assert.doesNotThrow(() => buildSummaryEmbed({}).toJSON());
  assert.doesNotThrow(() => buildActivityEmbed({}).toJSON());
  assert.doesNotThrow(() => buildGrowthEmbed({}).toJSON());
  assert.doesNotThrow(() => buildVoiceEmbed({}).toJSON());
});

test('unknown poster counts say so instead of printing zero', () => {
  // PER_MEMBER_COUNTERS=off leaves both poster figures null; a 0 here would read as
  // "nobody posted" on a server that was talking all day.
  const summary = buildSummaryEmbed({ window: '7d', guild: {}, totals: {} }).toJSON();
  assert.equal(summary.fields.find((f) => f.name === 'Posters').value, 'not measured');

  const activity = buildActivityEmbed({
    window: '7d',
    series: [{ messages: 10, unique_authors_exact: null }],
  }).toJSON();
  assert.equal(activity.fields.find((f) => f.name === 'Posters (sum of days)').value, 'not measured');
});

test('a long caveat is cut on a word boundary', () => {
  const long = `${'word '.repeat(80)}tail`;
  const json = buildSummaryEmbed({ window: '1d', guild: {}, totals: {}, caveats: [long] }).toJSON();
  assert.ok(json.footer.text.length <= 201);
  assert.ok(json.footer.text.endsWith('…'));
  assert.ok(!/wor…$/.test(json.footer.text), 'must not split a word');
});

test('activity embed sums the series instead of trusting a totals key', () => {
  const json = buildActivityEmbed({
    window: '7d',
    series: [
      { messages: 300, unique_authors_exact: 11 },
      { messages: 150, unique_authors_exact: 9 },
    ],
    top_channels: [
      { id: '10', name: 'general', messages: 400 },
      { id: '11', name: null, messages: 50 },
    ],
  }).toJSON();

  assert.equal(json.fields.find((f) => f.name === 'Messages').value, '450');
  assert.equal(json.fields.find((f) => f.name === 'Posters (sum of days)').value, '20');
  assert.match(json.fields.find((f) => f.name === 'Busiest channels').value, /<#10> — 400/);
});

test('growth embed names the install-day denominator', () => {
  const json = buildGrowthEmbed({
    window: '30d',
    totals: { joins: 5, leaves: 2, net: 3, members_now: 812 },
    tenure: { total_members: 800, last_30d: { members: 9, share: 0.011 }, last_90d: { members: 40, share: 0.05 } },
  }).toJSON();

  assert.equal(json.fields.find((f) => f.name === 'Members now').value, '812');
  assert.match(json.footer.text, /800 members at install/);
  assert.match(json.footer.text, /not today's count/);
});

/* ------------------------------------------------------------------ *
 * handler
 * ------------------------------------------------------------------ */

const logger = silentLogger;

/** Minimal stand-in for a ChatInputCommandInteraction. */
function fakeInteraction({
  commandName = 'stats',
  subcommand = 'summary',
  options = {},
  roleIds = [],
  manageGuild = false,
} = {}) {
  const calls = [];
  const interaction = {
    commandName,
    guildId: '1',
    user: { id: '42' },
    member:
      roleIds === null
        ? null
        : { roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } },
    memberPermissions: {
      has: (flag) => (flag === PermissionFlagsBits.ManageGuild ? manageGuild : false),
    },
    isChatInputCommand: () => true,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getRole: (name) => options[name] ?? null,
    },
    reply: async (payload) => calls.push({ kind: 'reply', payload }),
    editReply: async (payload) => calls.push({ kind: 'editReply', payload }),
    deferred: false,
    replied: false,
    calls,
  };
  return interaction;
}

const handler = () => createCommandHandler({ db, config, logger });

test('a non-command interaction is not claimed', async () => {
  const result = await handler()({ isChatInputCommand: () => false });
  assert.equal(result, false);
});

test('/stats summary replies with an embed built from the database', async () => {
  saveAllowedRoles(db, []); // unrestricted for this case
  const interaction = fakeInteraction({ subcommand: 'summary', options: { window: '30d' } });
  assert.equal(await handler()(interaction), true);

  const [{ payload }] = interaction.calls;
  assert.ok(payload.embeds?.length === 1, 'expected one embed');
  const json = payload.embeds[0].toJSON();
  assert.ok(json.fields.some((f) => f.name === 'Members'));
});

test('a restricted user is refused and the query never runs', async () => {
  saveAllowedRoles(db, [STAFF_ROLE]);
  const denied = fakeInteraction({ subcommand: 'summary', roleIds: ['unrelated'] });
  await handler()(denied);

  const [{ payload }] = denied.calls;
  assert.match(payload.content, /restricted/i);
  assert.equal(payload.ephemeral, true);
  assert.equal(payload.embeds, undefined, 'must not leak numbers to a denied caller');

  const allowed = fakeInteraction({ subcommand: 'growth', roleIds: [STAFF_ROLE] });
  await handler()(allowed);
  assert.ok(allowed.calls[0].payload.embeds?.length === 1);

  saveAllowedRoles(db, []);
});

test('an admin can still run /stats while it is restricted', async () => {
  saveAllowedRoles(db, [STAFF_ROLE]);
  const interaction = fakeInteraction({ subcommand: 'voice', roleIds: [], manageGuild: true });
  await handler()(interaction);
  assert.ok(interaction.calls[0].payload.embeds?.length === 1);
  saveAllowedRoles(db, []);
});

test('/stats-access refuses a non-admin and writes nothing', async () => {
  saveAllowedRoles(db, []);
  const interaction = fakeInteraction({
    commandName: 'stats-access',
    subcommand: 'add',
    options: { role: { id: STAFF_ROLE } },
    roleIds: [STAFF_ROLE], // holding the role must not grant config rights
    manageGuild: false,
  });
  await handler()(interaction);

  assert.match(interaction.calls[0].payload.content, /Manage Server/);
  assert.deepEqual(loadAllowedRoles(db), [], 'allowlist must be untouched');
});

test('/stats-access add, remove and clear persist to the database', async () => {
  saveAllowedRoles(db, []);

  const add = fakeInteraction({
    commandName: 'stats-access',
    subcommand: 'add',
    options: { role: { id: STAFF_ROLE } },
    manageGuild: true,
  });
  await handler()(add);
  assert.deepEqual(loadAllowedRoles(db), [STAFF_ROLE]);
  assert.match(add.calls[0].payload.content, /Added/);

  // Adding twice is a no-op, not a duplicate entry.
  await handler()(
    fakeInteraction({
      commandName: 'stats-access',
      subcommand: 'add',
      options: { role: { id: STAFF_ROLE } },
      manageGuild: true,
    }),
  );
  assert.deepEqual(loadAllowedRoles(db), [STAFF_ROLE]);

  const list = fakeInteraction({ commandName: 'stats-access', subcommand: 'list', manageGuild: true });
  await handler()(list);
  const embed = list.calls[0].payload.embeds[0].toJSON();
  assert.match(embed.description, new RegExp(STAFF_ROLE));

  const remove = fakeInteraction({
    commandName: 'stats-access',
    subcommand: 'remove',
    options: { role: { id: STAFF_ROLE } },
    manageGuild: true,
  });
  await handler()(remove);
  assert.deepEqual(loadAllowedRoles(db), []);
  assert.match(remove.calls[0].payload.content, /unrestricted/i);

  // Re-add then clear.
  saveAllowedRoles(db, [ADMIN_ROLE]);
  const clear = fakeInteraction({ commandName: 'stats-access', subcommand: 'clear', manageGuild: true });
  await handler()(clear);
  assert.deepEqual(loadAllowedRoles(db), [], 'clear must empty the list');
});

test('access embed marks roles that no longer exist', () => {
  const json = buildAccessEmbed([STAFF_ROLE], null).toJSON();
  assert.match(json.description, /role no longer exists/);

  const empty = buildAccessEmbed([], null).toJSON();
  assert.match(empty.description, /No restriction/);
});

/* ------------------------------------------------------------------ *
 * registration
 * ------------------------------------------------------------------ */

test('registerCommands replaces the guild command list', async () => {
  let stored = null;
  const guild = {
    name: 'HPNinjaz',
    commands: {
      set: async (cmds) => {
        stored = cmds;
        return new Map(cmds.map((c) => [c.name, c]));
      },
    },
  };
  const applied = await registerCommands(guild, logger);
  assert.equal(applied.size, 2);
  assert.deepEqual(stored.map((c) => c.name), ['stats', 'stats-access']);
});

test('registerCommands reports failure without throwing', async () => {
  const guild = {
    name: 'HPNinjaz',
    commands: {
      set: async () => {
        throw new Error('Missing Access');
      },
    },
  };
  // Collection must not die because commands could not be registered.
  const applied = await registerCommands(guild, logger);
  assert.equal(applied, null);
});
