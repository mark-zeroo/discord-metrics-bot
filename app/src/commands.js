import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import * as Q from './api/queries.js';
import { retention } from './api/cohorts.js';
import { coreConcentration } from './api/core.js';
import { channelLifecycle } from './api/lifecycle.js';
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

/* ------------------------------------------------------------------ *
 * suppression-aware rendering
 * ------------------------------------------------------------------ */

/**
 * Words for absence.
 *
 * An embed has no room for a status field beside every number, so the distinction
 * has to live in the value itself. "withheld", "not yet" and "not collected" are
 * three different facts, and printing 0 or a dash for any of them would undo the
 * suppression design at the last step — the one place a reader sees the number.
 */
const ABSENCE = {
  suppressed_small_count: 'withheld (too few)',
  suppressed_complementary: 'withheld (too few)',
  withheld_suppression: 'withheld',
  immature: 'not yet',
  unmeasured: 'not collected',
  no_data: 'no data',
  refused: 'declined',
};

function cellText(cell, render = (v) => num(v)) {
  if (!cell || typeof cell !== 'object') return '—';
  if (cell.status === 'published') return render(cell.value);
  return ABSENCE[cell.status] ?? '—';
}

const pct = (value) => `${Math.round(value * 100)}%`;

/**
 * Retention cells are {status, rate, retained, measured}, not {status, value}.
 * Rendering them through cellText() printed a dash for a perfectly good 0% —
 * which is the one outcome this whole design exists to avoid.
 */
const retentionCell = (cell) => (cell?.status === 'published' ? pct(cell.rate) : cellText(cell));

/** Why an uplift was not quoted, in words short enough for a field. */
const UPLIFT_ABSENCE = {
  not_started: 'not started',
  window_unobserved: 'window not collected',
  window_too_short: 'window too short',
  baseline_unmeasurable: 'no baseline yet',
  baseline_too_short: 'baseline too short',
  matched_baseline_thin: 'baseline too thin',
  no_baseline_activity: 'no baseline activity',
  insufficient_volume: 'too little activity',
  overlapping_event: 'overlaps another tag',
};

function unavailableEmbed(title, data, fallback) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(0xed4245)
    .setDescription(data?.reason ?? fallback)
    .setFooter({ text: 'This is a configuration or coverage state, not a zero.' });
}

/* ------------------------------------------------------------------ *
 * embeds for the analysis endpoints
 * ------------------------------------------------------------------ */

export function buildRetentionEmbed(data) {
  if (data?.available === false) {
    return unavailableEmbed('Retention — unavailable', data, 'Cohort retention needs per-member counters.');
  }

  const fields = [];
  const pooled = data?.pooled ?? {};
  for (const period of data?.periods ?? []) {
    const label = `d${period}`;
    const cell = pooled[label] ?? {};
    const value =
      cell.status === 'published'
        ? `${pct(cell.rate)} — ${num(cell.retained)} of ${num(cell.measured)} members, ` +
          `${num(cell.cohorts_included)} cohort${cell.cohorts_included === 1 ? '' : 's'}`
        : cellText(cell);
    fields.push({ name: `D${period} (pooled)`, value, inline: true });
  }

  const newest = Array.isArray(data?.cohorts) ? data.cohorts[data.cohorts.length - 1] : null;
  if (newest) {
    fields.push({
      name: 'Newest cohort',
      value:
        `${newest.cohort} — ${cellText(newest.members)} members\n` +
        `D1 ${retentionCell(newest.d1)} · D7 ${retentionCell(newest.d7)}`,
      inline: false,
    });
  }

  fields.push({
    name: 'Measured since',
    value: data?.basis?.activity_from
      ? data.basis.activity_from
      : 'not collected yet — per-member activity starts on the first message',
    inline: false,
  });

  if (data?.cohorts_truncated) {
    fields.push({
      name: 'Cohorts shown',
      value: `${num(data.cohorts.length)} newest of ${num(data.cohorts_total)}`,
      inline: true,
    });
  }

  return new EmbedBuilder()
    .setTitle(`Cohort retention — last ${data?.window ?? 'window'}`)
    .setColor(0x9b59b6)
    .addFields(fields)
    .setFooter({ text: footer(data?.caveats, 'Dn is activity on the day n days after joining.') });
}

export function buildCoreEmbed(data) {
  if (data?.available === false) {
    return unavailableEmbed('Core — unavailable', data, 'Core analysis needs per-member counters.');
  }

  const periods = Array.isArray(data?.periods) ? data.periods : [];
  const latest = periods[periods.length - 1];
  if (!latest) {
    return new EmbedBuilder()
      .setTitle(`Core — last ${data?.window ?? 'window'}`)
      .setColor(0xfee75c)
      .setDescription(data?.trend?.detail ?? 'No complete period has been measured yet.')
      .setFooter({ text: footer(data?.caveats, 'A period has to finish before it can be described.') });
  }

  const fields = [
    {
      name: `Latest period (${latest.period})`,
      value: `${cellText(latest.active_members)} active · core ${cellText(latest.core_size)}`,
      inline: false,
    },
  ];

  const c = latest.concentration;
  if (c) {
    fields.push({
      name: 'Concentration',
      value:
        `top 10% wrote ${pct(c.share_of_messages_from_top_10_percent)} · ` +
        `80% came from ${cellText(c.members_for_80_percent_of_messages)} members · ` +
        `gini ${c.gini}`,
      inline: false,
    });
  } else {
    // A full sentence belongs in the description, not in a metric field: the field
    // should say *what* the number is, the description should say why it is absent.
    fields.push({ name: 'Concentration', value: 'withheld (too few in the core)', inline: false });
  }

  const t = data?.latest_transition;
  if (t) {
    fields.push({
      name: `Core churn (${t.from} → ${t.to})`,
      value:
        `stayed ${cellText(t.stayed_core)} · slipped ${cellText(t.left_core_active)} · ` +
        `quiet ${cellText(t.left_core_inactive)} · left ${cellText(t.left_server_confirmed)}\n` +
        `kept ${cellText(t.core_retention_rate, pct)} of the core`,
      inline: false,
    });
  }

  const trend = data?.trend;
  fields.push({
    name: 'Trend',
    value:
      trend?.status === 'published'
        ? `${trend.gini.direction.replace(/_/g, ' ')} · gini ${trend.gini.early} → ${trend.gini.late} ` +
          `over ${num(trend.periods_compared)} periods`
        : (trend?.detail ?? 'not enough periods'),
    inline: false,
  });

  const embed = new EmbedBuilder()
    .setTitle(`Core of regulars — last ${data?.window ?? 'window'}`)
    .setColor(0xfee75c)
    .addFields(fields);
  if (!latest.concentration && latest.reason) embed.setDescription(latest.reason);
  return embed
    .setFooter({ text: footer(data?.caveats, 'Core is a share of active members, not a list of names.') });
}

const STAGE_ORDER = ['growing', 'steady', 'declining', 'low_volume', 'dormant', 'never_used', 'created_unused', 'removed', 'unmeasured'];
const STAGE_LABEL = {
  growing: 'growing',
  steady: 'steady',
  declining: 'declining',
  low_volume: 'low volume',
  dormant: 'dormant',
  never_used: 'never used',
  created_unused: 'created, unused',
  removed: 'removed',
  unmeasured: 'not measured',
};

export function buildChannelsEmbed(data) {
  if (data?.available === false) {
    return unavailableEmbed('Channels — unavailable', data, 'No server structure has been collected yet.');
  }

  const byStage = data?.by_stage ?? {};
  const summary = STAGE_ORDER.filter((stage) => (byStage[stage] ?? 0) > 0)
    .map((stage) => `${STAGE_LABEL[stage]} ${num(byStage[stage])}`)
    .join(' · ');

  const fields = [{ name: 'By stage', value: summary || 'No channels classified', inline: false }];

  const channelList = (entry, renderName) => {
    if (!entry || entry.channels.length === 0) return 'None';
    const names = entry.channels.map(renderName).join(', ');
    return entry.truncated ? `${names} … +${entry.total - entry.channels.length} more` : names;
  };

  const examples = data?.stage_examples ?? {};
  fields.push({
    name: `Dormant (${num(examples.dormant?.total ?? 0)})`,
    value: channelList(examples.dormant, (c) => `<#${c.id}>`),
    inline: false,
  });
  fields.push({
    name: `Never used (${num(examples.never_used?.total ?? 0)})`,
    value: channelList(examples.never_used, (c) => `\`${c.name}\``),
    inline: false,
  });

  const invisible = data?.counts?.invisible_to_bot ?? 0;
  if (invisible > 0) {
    fields.push({
      name: 'Not measured',
      value:
        `${num(invisible)} channel${invisible === 1 ? '' : 's'} the bot cannot see. ` +
        'Activity there is missing from every total, and an unmeasured channel is not an empty one.',
      inline: false,
    });
  }

  return new EmbedBuilder()
    .setTitle(`Channel lifecycle — last ${data?.window ?? 'window'}`)
    .setColor(0x5865f2)
    .addFields(fields)
    .setFooter({ text: footer(data?.caveats, 'Unmeasured is not the same as unused.') });
}

export function buildEventsEmbed(data) {
  const tags = Array.isArray(data?.tags) ? data.tags : [];
  if (tags.length === 0) {
    return new EmbedBuilder()
      .setTitle('Tagged events')
      .setColor(0x57f287)
      .setDescription('No events have been tagged yet. Use the tag CLI to add one.')
      .setFooter({ text: 'Uplift compares an event window with a weekday-matched baseline.' });
  }

  const fields = tags.slice(0, 5).map((tag) => {
    const during = tag.during;
    const uplift = tag.uplift?.messages;
    const status = tag.uplift_status?.messages;
    const outcome =
      Number.isFinite(uplift)
        ? `uplift ${uplift.toFixed(1)}×`
        : (UPLIFT_ABSENCE[status?.code] ?? status?.code ?? 'no uplift');
    const numbers = during
      ? `${num(during.messages)} msgs · ${num(during.joins)} joins`
      : tag.status === 'upcoming'
        ? 'not started'
        : 'window not collected';
    return {
      name: `${tag.name} (${tag.status})`,
      value: `${numbers} · ${outcome}`,
      inline: false,
    };
  });

  return new EmbedBuilder()
    .setTitle('Tagged events')
    .setColor(0x57f287)
    .addFields(fields)
    .setFooter({ text: footer(data?.caveats, 'Uplift is correlation, and only quoted when it can be defended.') });
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
    )
    // The three analysis views below answer questions a server lead actually asks,
    // and they inherit the same allowlist as the rest of /stats — one gate, not a
    // second permission system to reason about.
    .addSubcommand((sub) =>
      sub
        .setName('retention')
        .setDescription('Do new members come back? (D1 / D7 / D30)')
        .addStringOption(windowOption)
        .addStringOption((option) =>
          option
            .setName('cohort')
            .setDescription('Group joiners by week (default) or day')
            .addChoices({ name: 'Week', value: 'week' }, { name: 'Day', value: 'day' }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('core')
        .setDescription('Is the server carried by fewer people than it used to be?')
        .addStringOption(windowOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('channels')
        .setDescription('Which channels are growing, fading, or never used?')
        .addStringOption(windowOption)
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('Channels to list per group (default 5)')
            .setMinValue(1)
            .setMaxValue(10),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('events')
        .setDescription('Did the last tagged events move the needle?')
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('How many events to show (default 3)')
            .setMinValue(1)
            .setMaxValue(5),
        ),
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
    case 'retention':
      embed = buildRetentionEmbed(
        retention(db, config, {
          // A quarter of cohorts, not the window's default: retention is about
          // whether recent joiners stuck, and older cohorts are mostly unmeasured
          // anyway on a young install.
          window: resolveWindow(interaction.options.getString('window') ?? '90d'),
          cohort: interaction.options.getString('cohort') ?? 'week',
          periods: [1, 7, 30],
          limit: 8,
          ts,
        }),
      );
      break;
    case 'core':
      embed = buildCoreEmbed(
        coreConcentration(db, config, {
          window: resolveWindow(interaction.options.getString('window') ?? '90d'),
          bucket: 'week',
          ts,
        }),
      );
      break;
    case 'channels':
      embed = buildChannelsEmbed(
        channelLifecycle(db, config, {
          window: resolveWindow(interaction.options.getString('window') ?? '30d'),
          limit: interaction.options.getInteger('limit') ?? 5,
          ts,
        }),
      );
      break;
    case 'events':
      embed = buildEventsEmbed(
        Q.tags(db, config, { limit: interaction.options.getInteger('limit') ?? 3, ts }),
      );
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
