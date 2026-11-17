import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import * as Q from './api/queries.js';
import { WINDOWS } from './time.js';

/**
 * Slash commands for reading the metrics database from inside Discord.
 *
 * Two design rules, both because this process is otherwise a *collector* that
 * cannot write anything to Discord except its own counters:
 *
 *   1. Commands read the same query layer the HTTP API serves. There is no
 *      second implementation of "messages in the last 30 days" to drift out of
 *      sync, and no HTTP round trip or bearer token involved — the bot already
 *      holds the database handle.
 *   2. Nothing here can change collection. The only state a command writes is
 *      the role allowlist (a meta key), which affects who may *read* numbers.
 *
 * Rendering is split from I/O on purpose: buildSummaryEmbed() and friends are
 * pure, so the payload→embed mapping is testable without a gateway connection,
 * and canRunStats() takes a plain object so the permission decision never needs
 * a mocked discord.js Member.
 */

/** meta key holding the JSON array of role ids allowed to run /stats. */
export const ROLES_META_KEY = 'commands.stats.roles';

/** Window labels offered in the slash UI; must stay a subset of WINDOWS. */
export const WINDOW_CHOICES = [
  ['Last 24 hours', '1d'],
  ['Last 7 days', '7d'],
  ['Last 30 days', '30d'],
  ['Last 90 days', '90d'],
  ['All time', 'all'],
];

const DENIED = 'These stats are restricted to specific roles. Ask an admin for access.';

/* ------------------------------------------------------------------ *
 * allowlist storage
 * ------------------------------------------------------------------ */

/**
 * Read the allowlist. An empty array means "no restriction", which is the
 * default: the feature has to be useful before it is locked down, and a
 * fail-closed default would make a fresh install look broken.
 */
export function loadAllowedRoles(db) {
  const raw = db.getMeta(ROLES_META_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id) => typeof id === 'string' && id.length > 0))];
  } catch {
    // A corrupt value must not lock everyone out of /stats permanently.
    return [];
  }
}

export function saveAllowedRoles(db, roleIds) {
  const clean = [...new Set(roleIds.filter((id) => typeof id === 'string' && id.length > 0))];
  db.setMeta(ROLES_META_KEY, JSON.stringify(clean));
  return clean;
}

/* ------------------------------------------------------------------ *
 * permission decision
 * ------------------------------------------------------------------ */

/**
 * @param {object} args
 * @param {string[]} args.allowed        role ids from loadAllowedRoles
 * @param {Iterable<string>} args.roleIds roles the caller holds
 * @param {boolean} args.hasManageGuild   caller can manage the guild
 */
export function canRunStats({ allowed, roleIds, hasManageGuild }) {
  if (allowed.length === 0) return { ok: true, reason: 'unrestricted' };
  // Manage Guild is an override, not a bypass for crowd control: without it, a
  // typo in /stats-access could restrict the only person able to undo it.
  if (hasManageGuild) return { ok: true, reason: 'manage_guild' };
  const held = new Set(roleIds ?? []);
  for (const id of allowed) {
    if (held.has(id)) return { ok: true, reason: 'role' };
  }
  return { ok: false, reason: 'missing_role' };
}

/* ------------------------------------------------------------------ *
 * formatting helpers
 * ------------------------------------------------------------------ */

const num = (value) => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—');

const hours = (seconds) =>
  Number.isFinite(seconds) ? `${(seconds / 3600).toFixed(1)} h` : '—';

const list = (rows, render, empty = 'None recorded') => {
  if (!Array.isArray(rows) || rows.length === 0) return empty;
  return rows.map((row, i) => `${i + 1}. ${render(row)}`).join('\n');
};

/** First caveat as a footer, and never a wall of text. */
function footer(caveats, fallback) {
  const first = Array.isArray(caveats) ? caveats.find((c) => typeof c === 'string') : null;
  const text = first ?? fallback;
  if (text.length <= 200) return text;
  // Cut on a word boundary: "estimate a window t…" reads as a bug, not a summary.
  const clipped = text.slice(0, 200);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, lastSpace > 40 ? lastSpace : 200).trimEnd()}…`;
}

/* ------------------------------------------------------------------ *
 * embed builders (pure)
 * ------------------------------------------------------------------ */

export function buildSummaryEmbed(data) {
  const totals = data?.totals ?? {};
  const guild = data?.guild ?? {};
  const distinctive = Number.isFinite(totals.unique_posters) ? totals.unique_posters : null;
  const perDay = Number.isFinite(totals.avg_daily_posters) ? totals.avg_daily_posters : null;
  // Neither figure existing is not the same as zero people posting.
  const posters = distinctive !== null
    ? `**${num(distinctive)}** distinct`
    : perDay !== null
      ? `**${num(perDay)}** avg/day`
      : 'not measured';

  return new EmbedBuilder()
    .setTitle(`${guild.name ?? 'Server'} — ${data?.window ?? 'window'}`)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Members', value: num(guild.members), inline: true },
      { name: 'Online now', value: num(guild.online), inline: true },
      { name: 'Boosts', value: `${num(guild.boosts)} (tier ${guild.tier ?? '—'})`, inline: true },
      { name: 'Messages', value: num(totals.messages), inline: true },
      { name: 'Voice', value: hours(totals.voice_seconds), inline: true },
      { name: 'Joins / leaves', value: `${num(totals.joins)} / ${num(totals.leaves)}`, inline: true },
      { name: 'Posters', value: posters, inline: true },
      {
        name: 'Busiest channel',
        value: data?.busiest_channel?.name
          ? `<#${data.busiest_channel.id}> — ${num(data.busiest_channel.messages)}`
          : 'None recorded',
        inline: true,
      },
    )
    .setFooter({ text: footer(data?.caveats, 'Figures from recorded collection days only.') });
}

export function buildActivityEmbed(data) {
  const series = Array.isArray(data?.series) ? data.series : [];
  const total = series.reduce((acc, row) => acc + (row.messages ?? 0), 0);
  const exactRows = series.filter((row) => Number.isFinite(row.unique_authors_exact));
  // A missing distinct count must not print as 0 posters: on a server with no
  // per-member counters every row is null, and "0" is a claim, not a blank.
  const exact = exactRows.length
    ? num(exactRows.reduce((acc, row) => acc + row.unique_authors_exact, 0))
    : 'not measured';

  return new EmbedBuilder()
    .setTitle(`Message activity — ${data?.window ?? 'window'}`)
    .setColor(0x57f287)
    .addFields(
      { name: 'Messages', value: num(total), inline: true },
      { name: 'Days reported', value: num(series.length), inline: true },
      { name: 'Posters (sum of days)', value: exact, inline: true },
      {
        name: 'Busiest channels',
        value: list(data?.top_channels, (row) => {
          const name = row.name ? `<#${row.id}>` : `\`${row.id}\``;
          return `${name} — ${num(row.messages)}`;
        }),
      },
    )
    .setFooter({ text: footer(data?.caveats, 'Channels the bot cannot see are excluded.') });
}

export function buildGrowthEmbed(data) {
  const totals = data?.totals ?? {};
  const tenure = data?.tenure;

  const fields = [
    { name: 'Joins', value: num(totals.joins), inline: true },
    { name: 'Leaves', value: num(totals.leaves), inline: true },
    { name: 'Net', value: num(totals.net), inline: true },
    { name: 'Members now', value: num(totals.members_now), inline: true },
  ];

  if (tenure && Number.isFinite(tenure.last_30d?.members)) {
    fields.push({
      name: 'Joined in last 30d',
      value: `${num(tenure.last_30d.members)} (${(tenure.last_30d.share * 100).toFixed(0)}%)`,
      inline: true,
    });
  }
  if (tenure && Number.isFinite(tenure.last_90d?.members)) {
    fields.push({
      name: 'Joined in last 90d',
      value: `${num(tenure.last_90d.members)} (${(tenure.last_90d.share * 100).toFixed(0)}%)`,
      inline: true,
    });
  }

  return new EmbedBuilder()
    .setTitle(`Growth — ${data?.window ?? 'window'}`)
    .setColor(0xfee75c)
    .addFields(fields)
    .setFooter({
      // tenure.total_members is a frozen install-day figure; saying so here keeps
      // the percentages from being read as "share of the server today".
      text: tenure
        ? `Percentages divide by the ${num(tenure.total_members)} members at install, not today's count.`
        : footer(data?.caveats, 'Joins before install come from member join dates.'),
    });
}

export function buildVoiceEmbed(data) {
  const totals = data?.totals ?? {};
  return new EmbedBuilder()
    .setTitle(`Voice — ${data?.window ?? 'window'}`)
    .setColor(0xeb459e)
    .addFields(
      { name: 'Voice hours', value: hours(totals.voice_seconds), inline: true },
      { name: 'Active days', value: num(totals.active_buckets), inline: true },
      {
        name: 'Busiest channels',
        value: list(data?.top_channels, (row) => {
          const name = row.name ? `<#${row.id}>` : `\`${row.id}\``;
          return `${name} — ${hours(row.voice_hours * 3600)}`;
        }),
      },
    )
    .setFooter({ text: footer(data?.caveats, 'Member-seconds, excluding deafened members.') });
}

export function buildAccessEmbed(allowed, guild) {
  const lines = allowed.length
    ? allowed
        .map((id) => {
          const role = guild?.roles?.cache?.get?.(id);
          return role ? `<@&${id}>` : `\`${id}\` (role no longer exists)`;
        })
        .join('\n')
    : 'No restriction — anyone who can see the channel can run `/stats`.';

  return new EmbedBuilder()
    .setTitle('/stats access')
    .setColor(allowed.length ? 0xed4245 : 0x57f287)
    .setDescription(lines)
    .setFooter({
      text: 'Members with Manage Server always have access, so this can be undone.',
    });
}

/* ------------------------------------------------------------------ *
 * command definitions
 * ------------------------------------------------------------------ */

const windowOption = (option) =>
  option
    .setName('window')
    .setDescription('Time window')
    .addChoices(...WINDOW_CHOICES.map(([name, value]) => ({ name, value })));

export function definitions() {
  const stats = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Server activity statistics')
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub.setName('summary').setDescription('Headline numbers').addStringOption(windowOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('activity')
        .setDescription('Message activity and busiest channels')
        .addStringOption(windowOption)
        .addIntegerOption((option) =>
          option
            .setName('channels')
            .setDescription('How many channels to list (default 5)')
            .setMinValue(1)
            .setMaxValue(10),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('growth').setDescription('Joins, leaves and tenure').addStringOption(windowOption),
    )
    .addSubcommand((sub) =>
      sub.setName('voice').setDescription('Voice hours and busiest channels').addStringOption(windowOption),
    );

  const access = new SlashCommandBuilder()
    .setName('stats-access')
    .setDescription('Restrict who may use /stats')
    .setDMPermission(false)
    // Discord hides the command from anyone without this, which is a courtesy and
    // NOT the check that matters: the handler re-checks at execution time, because
    // server admins can grant this command to other roles.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the current restriction'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Allow a role to use /stats')
        .addRoleOption((option) =>
          option.setName('role').setDescription('Role to allow').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop allowing a role')
        .addRoleOption((option) =>
          option.setName('role').setDescription('Role to remove').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('clear').setDescription('Remove the restriction (everyone may use /stats)'),
    );

  return [stats.toJSON(), access.toJSON()];
}

/* ------------------------------------------------------------------ *
 * registration + dispatch
 * ------------------------------------------------------------------ */

/**
 * Register the commands on the target guild.
 *
 * Guild commands, not global ones: this bot is single-guild by construction
 * (bot.js leaves any other guild), and guild commands update instantly instead
 * of waiting on Discord's global propagation. `set()` replaces the whole list —
 * correct here, since this bot owns its command namespace.
 */
export async function registerCommands(guild, logger, commands = definitions()) {
  if (!guild?.commands?.set) {
    // Never throw: this is called from the ready handler, and a guild-shaped object
    // without a command manager (a test double, a partial cache) must not be able to
    // take down collection.
    logger.warn('guild has no command manager; slash commands not registered');
    return null;
  }
  try {
    const applied = await guild.commands.set(commands);
    logger.info('slash commands registered', { count: applied.size, guild: guild.name });
    return applied;
  } catch (err) {
    // Missing Access here almost always means the bot was invited without the
    // `applications.commands` scope. That is a one-line fix, but the raw error
    // ("Missing Access") explains nothing, so say what to do about it.
    logger.error('slash command registration failed', { error: err?.message ?? String(err) });
    logger.error('if this says Missing Access, re-invite the bot with the applications.commands scope');
    return null;
  }
}

function resolveWindow(label) {
  const key = WINDOWS.has(label) ? label : '30d';
  const seconds = WINDOWS.get(key);
  return { label: key, seconds, all: seconds === null };
}

/** Accept both a cached RoleManager and the raw id array an uncached interaction gives. */
function roleIdsOf(member) {
  const roles = member?.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) return roles;
  if (roles.cache) return [...roles.cache.keys()];
  return [];
}

async function reply(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}

async function handleStats(interaction, { db, config, logger }) {
  const allowed = loadAllowedRoles(db);
  const roleIds = roleIdsOf(interaction.member);
  const hasManageGuild = Boolean(
    interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild),
  );

  const verdict = canRunStats({ allowed, roleIds, hasManageGuild });
  if (!verdict.ok) {
    await reply(interaction, { content: DENIED, ephemeral: true });
    logger.debug('stats command denied', { user: interaction.user?.id, reason: verdict.reason });
    return true;
  }

  const sub = interaction.options.getSubcommand();
  const window = resolveWindow(interaction.options.getString('window') ?? '30d');
  const ts = Math.floor(Date.now() / 1000);

  let embed;
  switch (sub) {
    case 'summary':
      embed = buildSummaryEmbed(Q.summary(db, config, { window, ts }));
      break;
    case 'activity':
      embed = buildActivityEmbed(
        Q.activity(db, config, {
          window,
          bucket: 'day',
          top: interaction.options.getInteger('channels') ?? 5,
          ts,
        }),
      );
      break;
    case 'growth':
      embed = buildGrowthEmbed(Q.growth(db, config, { window, bucket: 'day', ts }));
      break;
    case 'voice':
      embed = buildVoiceEmbed(Q.voice(db, config, { window, bucket: 'day', top: 5, ts }));
      break;
    default:
      await reply(interaction, { content: `Unknown subcommand: ${sub}`, ephemeral: true });
      return true;
  }

  await reply(interaction, { embeds: [embed] });
  return true;
}

async function handleAccess(interaction, { db, logger }) {
  if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    await reply(interaction, {
      content: 'You need **Manage Server** to change who can use `/stats`.',
      ephemeral: true,
    });
    return true;
  }

  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild ?? null;

  if (sub === 'list') {
    await reply(interaction, { embeds: [buildAccessEmbed(loadAllowedRoles(db), guild)], ephemeral: true });
    return true;
  }

  if (sub === 'clear') {
    saveAllowedRoles(db, []);
    logger.info('stats access cleared', { by: interaction.user?.id });
    await reply(interaction, {
      content: 'Restriction removed — anyone who can see the channel can run `/stats`.',
      ephemeral: true,
    });
    return true;
  }

  const role = interaction.options.getRole('role');
  if (!role) {
    await reply(interaction, { content: 'That role no longer exists.', ephemeral: true });
    return true;
  }

  const current = loadAllowedRoles(db);
  const already = current.includes(role.id);

  if (sub === 'add') {
    if (already) {
      await reply(interaction, { content: `<@&${role.id}> is already allowed.`, ephemeral: true });
      return true;
    }
    const next = saveAllowedRoles(db, [...current, role.id]);
    logger.info('stats access role added', { by: interaction.user?.id, role: role.id });
    await reply(interaction, {
      content:
        `Added <@&${role.id}>. /stats now requires one of: ` +
        next.map((id) => `<@&${id}>`).join(', '),
      ephemeral: true,
    });
    return true;
  }

  if (sub === 'remove') {
    if (!already) {
      await reply(interaction, { content: `<@&${role.id}> is not on the list.`, ephemeral: true });
      return true;
    }
    const next = saveAllowedRoles(
      db,
      current.filter((id) => id !== role.id),
    );
    logger.info('stats access role removed', { by: interaction.user?.id, role: role.id });
    await reply(interaction, {
      content: next.length
        ? `Removed <@&${role.id}>. /stats now requires one of: ${next.map((id) => `<@&${id}>`).join(', ')}`
        : `Removed <@&${role.id}>. The list is empty, so /stats is unrestricted again.`,
      ephemeral: true,
    });
    return true;
  }

  await reply(interaction, { content: `Unknown subcommand: ${sub}`, ephemeral: true });
  return true;
}

/**
 * Returns a listener for InteractionCreate. Resolves false for interactions this
 * module does not own, so a future feature can add its own handler.
 */
export function createCommandHandler({ db, config, logger }) {
  return async function onInteraction(interaction) {
    if (!interaction?.isChatInputCommand?.()) return false;
    const name = interaction.commandName;
    if (name !== 'stats' && name !== 'stats-access') return false;

    try {
      if (name === 'stats-access') return await handleAccess(interaction, { db, logger });
      return await handleStats(interaction, { db, config, logger });
    } catch (err) {
      // A thrown error inside a handler leaves the interaction spinning for the
      // user; reply with something actionable before re-logging.
      logger.error('slash command failed', { command: name, error: err?.message ?? String(err) });
      try {
        await reply(interaction, {
          content: 'Something went wrong reading the metrics database. The error is in the bot log.',
          ephemeral: true,
        });
      } catch {
        /* interaction already gone */
      }
      return true;
    }
  };
}
