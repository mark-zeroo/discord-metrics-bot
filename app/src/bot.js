import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  Routes,
} from 'discord.js';

import { createCommandHandler, registerCommands } from './commands.js';

/**
 * How long to wait for the clientReady handler to finish after login resolves.
 *
 * `Client#login()` resolving does NOT mean the client is ready. In discord.js
 * 14.28 it awaits `ws.connect()`, which settles once the websocket is open —
 * before the READY packet has been parsed, before `guilds.cache` is filled, and
 * before `clientReady` is emitted. Treating login as "ready" therefore reads an
 * empty cache and a null guild on every single boot.
 */
const TIMED_OUT = Symbol('ready-timeout');

/**
 * Least-privilege gateway client.
 *
 * Intents requested — and each one is justified:
 *   Guilds            server/channel/role structure
 *   GuildMessages     messageCreate, for *counting only*
 *   GuildVoiceStates  voiceStateUpdate, for member-seconds
 *   GuildMembers      joins/leaves (privileged; the only one that is)
 *
 * Deliberately absent:
 *   MessageContent    would let the bot read what people type. Counting does
 *                     not need it, and `messageCreate` still fires without it.
 *   GuildPresences    not needed; online counts come from the REST snapshot.
 *   GuildModeration / GuildMessageReactions / anything else.
 *
 * If a future change wants a new intent, that is a security review, not a
 * config tweak — hence the single allowlist below rather than per-env flags.
 */
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMembers,
];

export function createBot({ config, db, collectors, logger }) {
  // Both intervals are operator-tunable (SNAPSHOT_INTERVAL_MINUTES,
  // READY_TIMEOUT_SECONDS); nothing here should need a code change to retune a
  // slow host or a guild with a lot of members to page through.
  const snapshotIntervalMs = config.runtime.snapshotIntervalMs;
  const readyTimeoutMs = config.runtime.readyTimeoutMs;

  const { token, guildId } = config.discord;

  const client = new Client({
    intents: INTENTS,
    // Never ping anyone. A metrics process must not be able to summon @here.
    allowedMentions: { parse: [], repliedUser: false },
    // No partials: only fully-cached guild structures are worth counting.
  });

  let snapshotTimer = null;
  let guild = null;
  let stopped = false;

  // Bridged by the clientReady handler below. Resolves to the guild object, or
  // null when the target guild genuinely is not visible. Resolving a promise is
  // idempotent, so the handler can settle it on every exit path safely.
  let settleReady;
  const readyGate = new Promise((resolve) => {
    settleReady = resolve;
  });

  const inTargetGuild = (id) => id === guildId;

  async function pollSnapshot() {
    try {
      // Cache-only, so it costs no REST calls. Kept on the poll interval because
      // role member counts drift as members are added or removed.
      refreshStructure();

      const data = await client.rest.get(Routes.guild(guildId), {
        query: new URLSearchParams({ with_counts: 'true' }),
      });
      const ts = Math.floor(Date.now() / 1000);
      const members = data.approximate_member_count ?? null;
      const online = data.approximate_presence_count ?? null;

      // The REST guild endpoint reports members and presences but not bots, so
      // derive the bot count from the member cache. GuildMembers is in the
      // intent list, which means GUILD_CREATE populates the whole cache at this
      // guild size. A partial cache would undercount, and a wrong number is
      // worse than null, so require the cache to cover the REST member count.
      let bots = null;
      const cachedMembers = guild?.members?.cache;
      if (!cachedMembers?.size) {
        logger.warn('member cache empty, bots left null', { members });
      } else if (!Number.isInteger(members) || cachedMembers.size >= members) {
        bots = cachedMembers.reduce((n, m) => n + (m.user.bot ? 1 : 0), 0);
        logger.debug('bot count derived from member cache', {
          bots,
          cached: cachedMembers.size,
          members,
        });
      } else {
        logger.warn('member cache short of REST count, bots left null', {
          cached: cachedMembers.size,
          members,
        });
      }

      db.run(
        `INSERT INTO snapshot(ts, members, bots, online, boosts, tier, channels, roles)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(ts) DO UPDATE SET
           members = excluded.members, bots = excluded.bots,
           online = excluded.online,
           boosts = excluded.boosts, tier = excluded.tier,
           channels = excluded.channels, roles = excluded.roles`,
        ts,
        members,
        bots,
        online,
        data.premium_subscription_count ?? null,
        data.premium_tier ?? null,
        guild?.channels?.cache?.size ?? null,
        guild?.roles?.cache?.size ?? null,
      );

      collectors.members.noteCounts({ members, bots, now: ts });
      logger.debug('snapshot polled', { members, online });
    } catch (err) {
      logger.warn('snapshot poll failed', { error: err?.message ?? String(err) });
    }
  }

  async function refreshScheduledEvents() {
    if (!guild) return;
    try {
      const events = await guild.scheduledEvents.fetch({ withUserCount: true });
      const observed = Math.floor(Date.now() / 1000);
      db.transaction(() => {
        for (const event of events.values()) {
          db.run(
            `INSERT INTO guild_event(event_id, name, start_ts, end_ts, user_count, status, observed_ts)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(event_id) DO UPDATE SET
               name = excluded.name, start_ts = excluded.start_ts, end_ts = excluded.end_ts,
               user_count = excluded.user_count, status = excluded.status,
               observed_ts = excluded.observed_ts`,
            event.id,
            // Event names are leader-authored content, not member data, but
            // cap length so a pathological name cannot bloat responses.
            String(event.name ?? '').slice(0, 200),
            event.scheduledStartTimestamp
              ? Math.floor(event.scheduledStartTimestamp / 1000)
              : null,
            event.scheduledEndTimestamp ? Math.floor(event.scheduledEndTimestamp / 1000) : null,
            event.subscriberCount ?? null,
            event.status ?? null,
            observed,
          );
        }
      });
    } catch (err) {
      logger.warn('scheduled event refresh failed', { error: err?.message ?? String(err) });
    }
  }

  // Channel type ids, mapped to words so the payload does not require the reader
  // to remember that 15 is a forum.
  const CHANNEL_TYPES = {
    0: 'text', 2: 'voice', 4: 'category', 5: 'announcement',
    10: 'thread', 11: 'thread', 12: 'thread', 13: 'stage',
    15: 'forum', 16: 'media',
  };

  const ROLE_FIELDS = ['name', 'position', 'permissions', 'color', 'hoist', 'mentionable', 'managed'];
  const CHANNEL_FIELDS = ['name', 'type', 'parent_id', 'position', 'nsfw', 'slowmode', 'overwrite_count', 'bot_can_view'];

  /** Field names that differ between a stored row and a freshly read one. */
  function changedFields(prev, next, fields) {
    return fields.filter((f) => {
      const a = prev[f] ?? null;
      const b = next[f] ?? null;
      return a !== b;
    });
  }

  function recordChange(ts, kind, targetId, target, detail) {
    db.run(
      'INSERT INTO structure_change(ts, kind, target_id, target, detail) VALUES(?,?,?,?,?)',
      ts,
      kind,
      targetId,
      String(target ?? '').slice(0, 120),
      detail ? String(detail).slice(0, 200) : null,
    );
  }

  /**
   * Persist server configuration: channels, roles, guild settings.
   *
   * No permission beyond the Guilds intent is involved. The bot can see that a
   * channel exists, what type it is, and how many permission overwrites it
   * carries *without* being able to read a single message in it, which is
   * exactly the split this wants: full configuration, zero content.
   *
   * Channel topics are deliberately not read. They are the one field on a
   * channel that routinely holds webhook URLs and invite links.
   */
  function refreshStructure() {
    if (!guild) return;
    const ts = Math.floor(Date.now() / 1000);
    const me = guild.members.me ?? null;

    // member_count per role is only meaningful when the whole member list is
    // cached; a partial cache silently undercounts, and a wrong number is worse
    // than none. Same rule pollSnapshot applies to the bot count.
    const cached = guild.members?.cache;
    const membersComplete = Boolean(
      cached?.size && (!Number.isInteger(guild.memberCount) || cached.size >= guild.memberCount),
    );
    const roleCounts = new Map();
    if (membersComplete) {
      for (const member of cached.values()) {
        for (const roleId of member.roles.cache.keys()) {
          roleCounts.set(roleId, (roleCounts.get(roleId) ?? 0) + 1);
        }
      }
    }

    try {
      db.transaction(() => {
        const prevChannels = new Map(
          db.all('SELECT * FROM channel_meta').map((r) => [r.channel_id, r]),
        );
        const prevRoles = new Map(db.all('SELECT * FROM role_meta').map((r) => [r.role_id, r]));

        // The very first refresh would otherwise log 131 channel_created and 153
        // role_created rows, dating the entire server to install day and burying
        // every genuine change that follows. One baseline row instead.
        const isFirstRun = prevChannels.size === 0 && prevRoles.size === 0;
        const seenChannels = new Set();

        for (const channel of guild.channels.cache.values()) {
          seenChannels.add(channel.id);
          // permissionsIn() is a cache-and-bitfield calculation, not an API
          // call: it answers "can I see this?" for free, and that answer is the
          // denominator every activity figure is missing.
          let canView = null;
          if (me) {
            try {
              canView = me.permissionsIn(channel).has(PermissionFlagsBits.ViewChannel) ? 1 : 0;
            } catch {
              canView = null;
            }
          }
          const row = {
            name: String(channel.name ?? 'unknown').slice(0, 120),
            type: CHANNEL_TYPES[channel.type] ?? 'other',
            parent_id: channel.parentId ?? null,
            position: channel.rawPosition ?? channel.position ?? null,
            nsfw: channel.nsfw ? 1 : 0,
            slowmode: channel.rateLimitPerUser ?? 0,
            overwrite_count: channel.permissionOverwrites?.cache?.size ?? 0,
            bot_can_view: canView,
          };

          const prev = prevChannels.get(channel.id);
          if (!prev || prev.deleted_ts) {
            if (!isFirstRun) recordChange(ts, 'channel_created', channel.id, row.name, row.type);
          } else {
            const fields = changedFields(prev, row, CHANNEL_FIELDS);
            if (fields.length) {
              recordChange(ts, 'channel_updated', channel.id, row.name, fields.join(', '));
            }
          }

          db.run(
            `INSERT INTO channel_meta(channel_id, name, type, parent_id, position, nsfw,
                                      slowmode, overwrite_count, bot_can_view, changed_ts, deleted_ts)
             VALUES(?,?,?,?,?,?,?,?,?,?,NULL)
             ON CONFLICT(channel_id) DO UPDATE SET
               name = excluded.name, type = excluded.type, parent_id = excluded.parent_id,
               position = excluded.position, nsfw = excluded.nsfw,
               slowmode = excluded.slowmode, overwrite_count = excluded.overwrite_count,
               bot_can_view = excluded.bot_can_view, changed_ts = excluded.changed_ts,
               deleted_ts = NULL`,
            channel.id, row.name, row.type, row.parent_id, row.position, row.nsfw,
            row.slowmode, row.overwrite_count, row.bot_can_view, ts,
          );
        }

        // Vanished channels and roles are marked, not dropped: "a channel was
        // deleted on 11/12" is frequently the explanation for a traffic change.
        for (const [id, prev] of prevChannels) {
          if (!prev.deleted_ts && !seenChannels.has(id)) {
            recordChange(ts, 'channel_deleted', id, prev.name, prev.type);
            db.run('UPDATE channel_meta SET deleted_ts = ?, changed_ts = ? WHERE channel_id = ?', ts, ts, id);
          }
        }

        const seenRoles = new Set();

        for (const role of guild.roles.cache.values()) {
          seenRoles.add(role.id);
          const row = {
            name: role.name === '@everyone' ? '@everyone' : String(role.name ?? '').slice(0, 120),
            position: role.position ?? null,
            color: Number.isInteger(role.color) ? role.color : null,
            hoist: role.hoist ? 1 : 0,
            managed: role.managed ? 1 : 0,
            mentionable: role.mentionable ? 1 : 0,
            permissions: role.permissions?.bitfield?.toString() ?? '0',
            member_count: membersComplete ? (roleCounts.get(role.id) ?? 0) : null,
          };

          const prev = prevRoles.get(role.id);
          if (!prev || prev.deleted_ts) {
            if (!isFirstRun) recordChange(ts, 'role_created', role.id, row.name, null);
          } else {
            const fields = changedFields(prev, row, ROLE_FIELDS);
            if (fields.length) {
              recordChange(ts, 'role_updated', role.id, row.name, fields.join(', '));
            }
          }

          db.run(
            `INSERT INTO role_meta(role_id, name, position, color, hoist, managed, mentionable,
                                   permissions, member_count, changed_ts, deleted_ts)
             VALUES(?,?,?,?,?,?,?,?,?,?,NULL)
             ON CONFLICT(role_id) DO UPDATE SET
               name = excluded.name, position = excluded.position, color = excluded.color,
               hoist = excluded.hoist, managed = excluded.managed,
               mentionable = excluded.mentionable, permissions = excluded.permissions,
               member_count = excluded.member_count, changed_ts = excluded.changed_ts,
               deleted_ts = NULL`,
            role.id, row.name, row.position, row.color, row.hoist, row.managed,
            row.mentionable, row.permissions, row.member_count, ts,
          );
        }

        for (const [id, prev] of prevRoles) {
          if (!prev.deleted_ts && !seenRoles.has(id)) {
            recordChange(ts, 'role_deleted', id, prev.name, null);
            db.run('UPDATE role_meta SET deleted_ts = ?, changed_ts = ? WHERE role_id = ?', ts, ts, id);
          }
        }

        // Guild-level settings: the part of the configuration that is not a
        // channel or a role. Stored as JSON in meta; the GUILD_UPDATE handler
        // diffs it so changes still land in structure_change as events.
        const settings = {
          verification_level: guild.verificationLevel ?? null,
          mfa_level: guild.mfaLevel ?? null,
          explicit_content_filter: guild.explicitContentFilter ?? null,
          afk_timeout: guild.afkTimeout ?? null,
          afk_channel: guild.afkChannel?.name ?? null,
          system_channel: guild.systemChannel?.name ?? null,
          rules_channel: guild.rulesChannel?.name ?? null,
          preferred_locale: guild.preferredLocale ?? null,
          features: Array.isArray(guild.features) ? [...guild.features].sort() : [],
          premium_tier: guild.premiumTier ?? null,
          premium_subscriptions: guild.premiumSubscriptionCount ?? null,
          emojis: guild.emojis?.cache?.size ?? null,
          stickers: guild.stickers?.cache?.size ?? null,
        };
        const encoded = JSON.stringify(settings);
        const previous = db.getMeta('structure.guild');
        if (previous !== encoded) {
          if (previous) {
            let detail = 'settings';
            try {
              const before = JSON.parse(previous);
              const keys = Object.keys(settings).filter(
                (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(settings[k] ?? null),
              );
              if (keys.length) detail = keys.join(', ');
            } catch {
              /* unparseable previous value: still worth recording the change */
            }
            recordChange(ts, 'guild_updated', guild.id, guild.name, detail);
          }
          db.setMeta('structure.guild', encoded);
        }
        if (isFirstRun) {
          // Count the way the API counts. Discord's channel list includes the
          // categories themselves, so quoting cache.size here produced a
          // baseline row reading "132 channels" next to a payload saying 119,
          // and the two numbers sit in the same response for anyone to trip on.
          let baselineChannels = 0;
          let baselineCategories = 0;
          for (const ch of guild.channels.cache.values()) {
            if (ch.type === ChannelType.GuildCategory) baselineCategories += 1;
            else baselineChannels += 1;
          }
          recordChange(
            ts,
            'structure_baseline',
            guild.id,
            guild.name,
            `${baselineChannels} channels, ${baselineCategories} categories, ${guild.roles.cache.size} roles`,
          );
        }
        db.setMeta('structure.refreshed_ts', ts);
      });
    } catch (err) {
      logger.warn('structure refresh failed', { error: err?.message ?? String(err) });
    }
  }

  function refreshChannelNames() {
    if (!guild) return;
    const ts = Math.floor(Date.now() / 1000);
    db.transaction(() => {
      for (const channel of guild.channels.cache.values()) {
        db.run(
          `INSERT INTO channel_name(channel_id, name, updated_ts) VALUES(?,?,?)
           ON CONFLICT(channel_id) DO UPDATE SET
             name = excluded.name, updated_ts = excluded.updated_ts`,
          channel.id,
          String(channel.name ?? 'unknown').slice(0, 120),
          ts,
        );
      }
    });
  }

  /** A bot token reused elsewhere, or a wrong ID, must not silently collect. */
  async function enforceSingleGuild() {
    for (const other of client.guilds.cache.values()) {
      if (other.id === guildId) continue;
      logger.error('bot is present in a non-target guild; leaving', {
        guildId: other.id,
        name: other.name,
      });
      try {
        await other.leave();
      } catch (err) {
        logger.error('failed to leave foreign guild', { error: err?.message });
      }
    }
  }

  client.once(Events.ClientReady, async (ready) => {
    try {
      logger.info('gateway connected', {
        user: ready.user.tag,
        guilds: ready.guilds.cache.size,
        intents: INTENTS,
      });

      guild = client.guilds.cache.get(guildId) ?? null;
      if (!guild) {
        logger.error('target guild not visible to this bot', {
          wanted: guildId,
          visible: [...ready.guilds.cache.keys()],
        });
        // Fail closed: collection without a guild is meaningless, and retrying
        // forever would just fill logs.
        process.exitCode = 1;
        settleReady(null);
        await client.destroy();
        return;
      }

      db.setMeta('guild.id', guild.id);
      db.setMeta('guild.name', guild.name);
      db.setMeta('bot.userId', ready.user.id);

      // Only drop foreign guilds once the target is confirmed present. Doing
      // this first meant a typo'd DISCORD_GUILD_ID would make the bot leave
      // every guild it was in — including the one you meant to collect from.
      await enforceSingleGuild();

      refreshChannelNames();
      refreshStructure();

      // GUILD_CREATE normally carries the full member list when GuildMembers is
      // requested, but "normally" is not a strong enough guarantee for the bot
      // count. Fetch explicitly so members.cache is authoritative before the
      // first snapshot, rather than discovering it empty and storing null.
      try {
        await guild.members.fetch();
      } catch (err) {
        logger.warn('member fetch failed; bot count may stay null', {
          error: err?.message ?? String(err),
        });
      }

      await pollSnapshot();
      await refreshScheduledEvents();

      snapshotTimer = setInterval(() => {
        if (stopped) return;
        pollSnapshot();
      }, snapshotIntervalMs);
      snapshotTimer.unref?.();

      logger.info('collectors active', {
        guild: guild.name,
        members: guild.memberCount,
        channels: guild.channels.cache.size,
      });

      settleReady(guild);

      // Register commands AFTER readiness is signalled, deliberately. index.js does
      // process.exit(1) when start() comes back null, and start() races the ready
      // gate against READY_TIMEOUT_SECONDS — so awaiting a REST call here would let a
      // slow or rate-limited command registration turn into an exit(1) crash loop.
      // Losing slash commands must never cost collection.
      await registerCommands(guild, logger);
    } catch (err) {
      // Never leave start() hanging on an unexpected failure.
      logger.error('ready handler failed', { error: err?.message ?? String(err) });
      process.exitCode = 1;
      settleReady(null);
    }
  });

  // Interactions arrive over the same gateway connection as everything else, so no
  // extra intent is involved (Guilds already covers them).
  const onCommand = createCommandHandler({ db, config, logger });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!inTargetGuild(interaction.guildId)) return;
    onCommand(interaction).catch((err) => {
      logger.error('interaction dispatch failed', { error: err?.message ?? String(err) });
    });
  });

  client.on(Events.MessageCreate, (message) => {
    collectors.messages.onMessage(message, { guildId });
  });

  client.on(Events.GuildMemberAdd, (member) => {
    if (!inTargetGuild(member.guild.id)) return;
    collectors.members.onJoin(member);
  });

  client.on(Events.GuildMemberRemove, (member) => {
    if (!inTargetGuild(member.guild.id)) return;
    collectors.members.onLeave(member);
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    collectors.voice.onVoiceStateUpdate(oldState, newState, { guildId });
  });

  client.on(Events.GuildScheduledEventCreate, () => refreshScheduledEvents());
  client.on(Events.GuildScheduledEventUpdate, () => refreshScheduledEvents());
  client.on(Events.GuildScheduledEventDelete, () => refreshScheduledEvents());

  client.on(Events.ChannelUpdate, () => {
    refreshChannelNames();
    refreshStructure();
  });
  client.on(Events.ChannelCreate, () => {
    refreshChannelNames();
    refreshStructure();
  });
  client.on(Events.ChannelDelete, () => {
    refreshChannelNames();
    refreshStructure();
  });
  client.on(Events.RoleCreate, () => refreshStructure());
  client.on(Events.RoleUpdate, () => refreshStructure());
  client.on(Events.RoleDelete, () => refreshStructure());

  client.on(Events.GuildUpdate, () => {
    if (guild) logger.debug('guild updated', { boosts: guild.premiumSubscriptionCount });
    // Guild-level settings (AFK channel, verification level, locale, boosts) live in
    // structure.guild, and refreshStructure is what diffs them into structure_change.
    // Without this call they were only picked up on the next unrelated channel or
    // role event, or the next restart — so setting an AFK channel could go unrecorded
    // indefinitely, which is the kind of change this endpoint exists to show.
    refreshStructure();
  });

  client.on(Events.Error, (err) => {
    logger.error('gateway error', { error: err?.message ?? String(err) });
  });

  client.on(Events.Warn, (msg) => logger.warn('gateway warning', { message: msg }));

  // discord.js re-emits REST deprecation notices through 'debug'; never attach
  // a debug listener: it can echo request headers.

  return {
    client,
    get guild() {
      return guild;
    },
    refreshScheduledEvents,
    refreshChannelNames,
    pollSnapshot,
    /**
     * Resolves once the clientReady handler has run, with the guild object or
     * null. Callers must not read `guild` straight after a bare `login()`.
     */
    async start() {
      // Rejects on a bad token or disallowed intents; that is a real error.
      await client.login(token);

      const outcome = await Promise.race([
        readyGate,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(TIMED_OUT), readyTimeoutMs);
          timer.unref?.();
        }),
      ]);

      if (outcome === TIMED_OUT) {
        logger.error('clientReady did not fire after login', { timeoutMs: readyTimeoutMs });
        return null;
      }

      return outcome;
    },
    async stop() {
      stopped = true;
      if (snapshotTimer) clearInterval(snapshotTimer);
      try {
        await client.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}
