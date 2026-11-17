import { DAY, HOUR, hourOf, dayOf } from '../time.js';

const MAX_SESSION_SECONDS = 12 * HOUR; // a stuck session cannot bill a whole day

/**
 * Voice is measured in *member-seconds*, not "people in a call". Discord does
 * not expose that distinction either; anything else would be a guess dressed
 * up as a metric.
 *
 * What counts as being in voice depends on `countMode`:
 *
 *   'present' (default) — anyone sitting in a non-AFK channel, muted or not.
 *     This is how a phone-based group actually uses voice: join the lobby,
 *     mute the mic, play. Filtering those members out produced a hard zero for
 *     servers where nobody ever unmutes, which reads as "voice is dead" when
 *     the channels are busy.
 *   'unmuted' — only members who are neither self-muted, self-deafened nor
 *     server-deafened. Closer to "who can actually talk", and the historical
 *     behaviour of this collector.
 *
 * Excluded in both modes:
 *   - bots
 *   - the AFK channel (sitting there is not participation)
 *   - excluded roles
 *
 * A member alone in a channel *is* counted. Communities routinely sit in a
 * lobby channel while queueing for a game, so "alone" is often still
 * engagement — and inventing an "alone" heuristic would silently drop real
 * minutes.
 */
export function createVoiceCollector({
  identity,
  excludedRoleIds,
  afkChannelId = null,
  countMode = 'present',
}) {
  /** @type {Map<string, {channelId:string, key:string, cursor:number}>} */
  const sessions = new Map();

  // Resolved after GUILD_CREATE; the AFK channel is not known at construction.
  let afk = afkChannelId;

  /** hour -> Map<channelId, {seconds, users:Set<string>}> */
  const hours = new Map();
  const days = new Map();

  /** hour -> Map<key, seconds>. Only populated when identity.persistable. */
  const memberHours = new Map();

  /**
   * What this process has already written, per bucket. Same reasoning as the
   * message collector: the counters above restart at zero, so a flush that
   * wrote them as an absolute value would truncate a day that an earlier
   * process had already partly filled. Only the delta is persisted.
   */
  const persistedHours = new Map(); // hour -> Map<channelId, seconds>
  const persistedDays = new Map(); // day  -> Map<channelId, seconds>
  const persistedMembers = new Map(); // hour -> Map<key, seconds>

  /** The one place that decides whether a voice state counts as participation. */
  function eligible(channelId, state) {
    if (!channelId) return false;
    if (channelId === afk) return false;
    if (countMode === 'unmuted') {
      if (state?.selfDeaf === true || state?.serverDeaf === true || state?.selfMute === true) {
        return false;
      }
    }
    return true;
  }

  const bootTs = Math.floor(Date.now() / 1000);
  const bootDay = dayOf(bootTs);
  const bootedMidDay = bootTs > bootDay;

  let started = 0;
  // Diagnostics for the last seed() call: how many voice states were visible and how
  // many could not be resolved to a member. Both are zero in a healthy boot.
  let lastSeedUnknown = 0;
  let lastSeedStates = 0;

  function slot(map, key, channelId) {
    let byChannel = map.get(key);
    if (!byChannel) {
      byChannel = new Map();
      map.set(key, byChannel);
    }
    let entry = byChannel.get(channelId);
    if (!entry) {
      entry = { seconds: 0, users: new Set() };
      byChannel.set(channelId, entry);
    }
    return entry;
  }

  function isExcluded(member) {
    if (excludedRoleIds.size === 0) return false;
    const roles = member?.roles?.cache;
    if (!roles) return false;
    for (const id of excludedRoleIds) if (roles.has(id)) return true;
    return false;
  }

  /** Seconds not yet persisted for this bucket, or null when nothing is new. */
  function deltaFor(persisted, bucket, key, total) {
    const written = persisted.get(bucket)?.get(key) ?? 0;
    return total > written ? total - written : null;
  }

  function markPersisted(persisted, bucket, key, total) {
    let byKey = persisted.get(bucket);
    if (!byKey) {
      byKey = new Map();
      persisted.set(bucket, byKey);
    }
    byKey.set(key, total);
  }

  /** Partial when this process booted mid-day: the earlier hours are missing. */
  function isPartialDay(d) {
    return d === bootDay && bootedMidDay ? 1 : 0;
  }

  /** Attribute [from, to) to hour and day buckets, splitting at boundaries. */
  function accrue(channelId, key, from, to) {
    let cursor = from;
    let budget = MAX_SESSION_SECONDS;
    while (cursor < to && budget > 0) {
      // Never let one slice span an hour boundary, or hourly buckets blur.
      const nextBoundary = Math.min(to, hourOf(cursor) + HOUR);
      const slice = Math.min(nextBoundary - cursor, budget);
      if (slice <= 0) break;

      const hSlot = slot(hours, hourOf(cursor), channelId);
      hSlot.seconds += slice;
      hSlot.users.add(key);

      const dSlot = slot(days, dayOf(cursor), channelId);
      dSlot.seconds += slice;
      dSlot.users.add(key);

      if (identity.persistable) {
        const h = hourOf(cursor);
        let byKey = memberHours.get(h);
        if (!byKey) {
          byKey = new Map();
          memberHours.set(h, byKey);
        }
        byKey.set(key, (byKey.get(key) ?? 0) + slice);
      }

      budget -= slice;
      cursor += slice;
    }
  }

  function close(userId, now, { commit = true } = {}) {
    const session = sessions.get(userId);
    if (!session) return;
    if (commit) accrue(session.channelId, session.key, session.cursor, Math.max(session.cursor, now));
    sessions.delete(userId);
  }

  /**
   * Adopt members who are already sitting in a voice channel when this process
   * starts.
   *
   * Sessions live only in memory and are otherwise opened by a voiceStateUpdate,
   * which a member already in a channel never sends. So after every restart
   * anyone currently in voice was invisible until they muted, moved or left — and
   * with a bot that redeploys often, that can be most of the voice time on the
   * server. Time before this call is genuinely unknown, so the session starts at
   * `now` rather than extrapolating backwards into minutes nobody measured.
   */
  function seed(guild, now = Math.floor(Date.now() / 1000)) {
    const states = guild?.voiceStates?.cache;
    if (!states) return 0;
    let opened = 0;
    let unknown = 0;
    for (const state of states.values()) {
      // `state.member` is a getter over guild.members.cache, so it is null whenever the
      // member is not cached — and a cache sweep or a boot that races the member fetch
      // both produce that. Fall back to an explicit lookup by user id rather than
      // silently adopting nobody, which looks identical to an idle server.
      const member = state.member ?? guild?.members?.cache?.get?.(state.id) ?? null;
      const user = member?.user;
      if (!user || user.bot) {
        if (member) continue;
        // No member object at all: cannot tell a bot from a person, so skip and count
        // it. A non-zero figure here with people in channels is the bug to chase.
        unknown += 1;
        continue;
      }
      if (isExcluded(member)) continue;
      if (sessions.has(user.id)) continue;

      const channelId = state.channelId;
      if (!eligible(channelId, state)) continue;

      sessions.set(user.id, {
        channelId,
        key: identity.keyFor(user.id),
        cursor: now,
      });
      started += 1;
      opened += 1;
    }
    lastSeedUnknown = unknown;
    lastSeedStates = states.size;
    return opened;
  }

  return {
    name: 'voice',

    seed,

    onVoiceStateUpdate(oldState, newState, { guildId }) {
      const guild = newState.guild ?? oldState.guild;
      if (!guild || guild.id !== guildId) return;

      const member = newState.member ?? oldState.member;
      const user = member?.user ?? newState.member?.user;
      if (!user || user.bot) return;
      if (isExcluded(member)) return;

      const userId = user.id;
      const now = Math.floor(Date.now() / 1000);

      const prevChannel = oldState.channelId;
      const nextChannel = newState.channelId;

      // 'present' mode deliberately ignores mute/deafen: a muted member is still
      // sitting in the call, which is the thing being measured there.
      const qualifies = eligible(nextChannel, newState);

      if (prevChannel && (prevChannel !== nextChannel || !qualifies)) {
        close(userId, now);
      }

      if (qualifies && !sessions.has(userId)) {
        sessions.set(userId, {
          channelId: nextChannel,
          key: identity.keyFor(userId),
          cursor: now,
        });
        started += 1;
      }
    },

    /** Advance open sessions so long calls surface in near-real-time buckets. */
    tick(now = Math.floor(Date.now() / 1000)) {
      for (const session of sessions.values()) {
        const upTo = Math.min(now, session.cursor + MAX_SESSION_SECONDS);
        if (upTo > session.cursor) {
          accrue(session.channelId, session.key, session.cursor, upTo);
          session.cursor = upTo;
        } else if (now > session.cursor) {
          // Pathological clock jump; resynchronise without billing the gap.
          session.cursor = now;
        }
      }
    },

    setAfkChannel(channelId) {
      afk = channelId ?? null;
    },

    stats() {
      return {
        activeSessions: sessions.size,
        started,
        countMode,
        pendingHours: hours.size,
        pendingDays: days.size,
        lastSeedStates,
        lastSeedUnknown,
      };
    },

    flush(db, now = Math.floor(Date.now() / 1000)) {
      this.tick(now);
      const currentHour = hourOf(now);

      db.transaction(() => {
        for (const [h, byChannel] of hours) {
          if (h > currentHour) continue;
          for (const [channelId, entry] of byChannel) {
            const delta = deltaFor(persistedHours, h, channelId, entry.seconds);
            if (delta === null) continue;

            const prev = db.get(
              'SELECT seconds, unique_users FROM voice_hour WHERE hour_ts = ? AND channel_id = ?',
              h,
              channelId,
            );

            db.run(
              `INSERT INTO voice_hour(hour_ts, channel_id, seconds, unique_users)
               VALUES(?,?,?,?)
               ON CONFLICT(hour_ts, channel_id) DO UPDATE SET
                 seconds = excluded.seconds,
                 unique_users = excluded.unique_users`,
              h,
              channelId,
              (prev?.seconds ?? 0) + delta,
              Math.max(prev?.unique_users ?? 0, entry.users.size),
            );
            markPersisted(persistedHours, h, channelId, entry.seconds);
          }
        }

        for (const [d, byChannel] of days) {
          for (const [channelId, entry] of byChannel) {
            const delta = deltaFor(persistedDays, d, channelId, entry.seconds);
            if (delta === null) continue;

            const prev = db.get(
              'SELECT seconds, unique_users, partial FROM voice_day WHERE day_ts = ? AND channel_id = ?',
              d,
              channelId,
            );

            const partial = Math.max(prev?.partial ?? 0, isPartialDay(d));
            const seconds = !prev
              ? entry.seconds
              : prev.partial
                ? prev.seconds + delta
                : Math.max(prev.seconds, entry.seconds);

            db.run(
              `INSERT INTO voice_day(day_ts, channel_id, seconds, unique_users, partial)
               VALUES(?,?,?,?,?)
               ON CONFLICT(day_ts, channel_id) DO UPDATE SET
                 seconds = excluded.seconds,
                 unique_users = excluded.unique_users,
                 partial = excluded.partial`,
              d,
              channelId,
              seconds,
              Math.max(prev?.unique_users ?? 0, entry.users.size),
              partial,
            );
            markPersisted(persistedDays, d, channelId, entry.seconds);
          }
        }

        // messages is deliberately absent so a row already written by the
        // message collector keeps its count on conflict.
        for (const [h, byKey] of memberHours) {
          if (h > currentHour) continue;
          for (const [key, seconds] of byKey) {
            const delta = deltaFor(persistedMembers, h, key, seconds);
            if (delta === null) continue;

            const prev = db.get(
              'SELECT voice_s FROM member_hour WHERE hour_ts = ? AND user_hmac = ?',
              h,
              key,
            );

            db.run(
              `INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s)
               VALUES(?,?,0,?)
               ON CONFLICT(hour_ts, user_hmac) DO UPDATE SET
                 voice_s = excluded.voice_s`,
              h,
              key,
              (prev?.voice_s ?? 0) + delta,
            );
            markPersisted(persistedMembers, h, key, seconds);
          }
        }
      });

      for (const h of hours.keys()) if (h < currentHour - 3600) hours.delete(h);
      for (const d of days.keys()) if (d < bootDay - DAY) days.delete(d);
      for (const h of memberHours.keys()) if (h < currentHour - 3600) memberHours.delete(h);

      // Stricter schedule than the counters they mirror: dropping a marker
      // while its bucket is still in RAM would re-add the running total.
      for (const h of persistedHours.keys()) if (h < currentHour - 3 * 3600) persistedHours.delete(h);
      for (const h of persistedMembers.keys()) if (h < currentHour - 3 * 3600) persistedMembers.delete(h);
      for (const d of persistedDays.keys()) if (d < bootDay - 2 * DAY) persistedDays.delete(d);
    },

    /** Called once at boot: in-flight sessions cannot survive a restart. */
    abandonAll(logger) {
      const count = sessions.size;
      if (count > 0) {
        logger?.warn('discarding in-flight voice sessions from previous run', { count });
      }
      sessions.clear();
      return count;
    },

    reset() {
      sessions.clear();
      hours.clear();
      days.clear();
      memberHours.clear();
      persistedHours.clear();
      persistedDays.clear();
      persistedMembers.clear();
    },
  };
}

export { MAX_SESSION_SECONDS };
