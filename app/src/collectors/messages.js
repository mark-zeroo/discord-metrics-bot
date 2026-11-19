import { DAY, hourOf, dayOf } from '../time.js';
import { addMemberDayMessages } from '../tenure.js';

/**
 * Message *counting*. No content, no attachments, no embeds, no author id is
 * ever written down in the default mode.
 *
 * The only reason a per-author value exists at all is deduplication for the
 * "unique authors" metric, and it lives purely in a Set in RAM that is dropped
 * when the bucket ages out.
 */
export function createMessageCollector({ identity, excludedRoleIds, perChannel }) {
  /** hour  -> Map<channelId, {messages, authors:Set}> */
  const hours = new Map();
  /** day   -> Map<channelId, {messages, authors:Set}> */
  const days = new Map();

  /**
   * Guild-wide distinct posters, deduplicated across channels in RAM and
   * persisted as a bare count. This is the figure that makes "how many people
   * actually talked" answerable; per-channel sets cannot be summed without
   * double-counting anyone who posts in two channels.
   */
  const posterHours = new Map(); // hour -> Set<key>
  const posterDays = new Map(); // day  -> Set<key>

  /**
   * hour -> Map<key, messageCount>. Populated only when identity.persistable,
   * i.e. PER_MEMBER_COUNTERS=hmac. In 'off' mode keyFor() returns a boot-random
   * pseudonym, so writing these rows would create per-member records that are
   * meaningless across restarts — exactly what that mode exists to prevent.
   */
  const memberHours = new Map();

  /**
   * day -> Map<key, messageCount>. The daily twin of memberHours, for retention.
   *
   * member_hour is pruned with hourly retention, so a D30 retention question asked
   * about a cohort older than the hourly horizon had no activity rows left to
   * answer it. Keeping a per-member *day* row (one per member per active day) makes
   * the long-range question answerable without keeping every hour forever.
   */
  const memberDays = new Map();

  /**
   * What *this process* has already persisted, per bucket and key.
   *
   * The in-memory counters above start at zero on every boot, so a flush that
   * writes them as an absolute value silently truncates any bucket an earlier
   * process had partially filled. That is not a theoretical concern: a restart
   * inside a day rewrites that day's row down to "messages seen since boot",
   * while the hourly rows for the same day keep the true figure — the day row
   * then contradicts the hours that compose it. Tracking what has been written
   * lets a flush persist only the delta, so restarts add instead of replace.
   */
  const persistedHours = new Map(); // hour -> Map<channelId, n>
  const persistedDays = new Map(); // day  -> Map<channelId, n>
  const persistedMembers = new Map(); // hour -> Map<key, n>
  const persistedMemberDays = new Map(); // day -> Map<key, n>

  const bootTs = Math.floor(Date.now() / 1000);
  const bootDay = dayOf(bootTs);
  const bootHour = hourOf(bootTs);
  const bootedMidDay = bootTs > bootDay;

  let received = 0;
  let ignored = 0;

  function slot(map, key, channelId) {
    let byChannel = map.get(key);
    if (!byChannel) {
      byChannel = new Map();
      map.set(key, byChannel);
    }
    let entry = byChannel.get(channelId);
    if (!entry) {
      entry = { messages: 0, authors: new Set() };
      byChannel.set(channelId, entry);
    }
    return entry;
  }

  function addKey(map, bucketTs, key) {
    let set = map.get(bucketTs);
    if (!set) {
      set = new Set();
      map.set(bucketTs, set);
    }
    set.add(key);
  }

  function isExcluded(member) {
    if (excludedRoleIds.size === 0) return false;
    const roles = member?.roles?.cache;
    if (!roles) return false;
    for (const id of excludedRoleIds) if (roles.has(id)) return true;
    return false;
  }

  /** Returns how much of `total` has not been written yet, or null for none. */
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

  /**
   * A day is partial when this process booted after the day began: whatever
   * happened between midnight and the boot is not in these counters, so the row
   * is a lower bound and future flushes must add to it rather than replace it.
   */
  function isPartialDay(d) {
    return d === bootDay && bootedMidDay ? 1 : 0;
  }

  return {
    name: 'messages',

    onMessage(message, { guildId }) {
      if (!message.inGuild() || message.guildId !== guildId) return;
      if (message.author?.bot || message.system) {
        ignored += 1;
        return;
      }
      if (isExcluded(message.member)) {
        ignored += 1;
        return;
      }

      // createdTimestamp is the message's own time, but a burst of queued
      // events after a reconnect can carry stale stamps; clamp to now so a
      // bucket is never written for a time we have already pruned.
      const now = Math.floor(Date.now() / 1000);
      const ts = Math.min(Math.floor(message.createdTimestamp / 1000) || now, now);

      const h = hourOf(ts);
      const d = dayOf(ts);
      const channelId = perChannel ? message.channelId : '*';
      const key = identity.keyFor(message.author.id);

      const hSlot = slot(hours, h, channelId);
      hSlot.messages += 1;
      hSlot.authors.add(key);

      const dSlot = slot(days, d, channelId);
      dSlot.messages += 1;
      dSlot.authors.add(key);

      addKey(posterHours, h, key);
      addKey(posterDays, d, key);

      if (identity.persistable) {
        let byKey = memberHours.get(h);
        if (!byKey) {
          byKey = new Map();
          memberHours.set(h, byKey);
        }
        byKey.set(key, (byKey.get(key) ?? 0) + 1);

        let byDay = memberDays.get(d);
        if (!byDay) {
          byDay = new Map();
          memberDays.set(d, byDay);
        }
        byDay.set(key, (byDay.get(key) ?? 0) + 1);
      }

      received += 1;
    },

    stats() {
      return {
        received,
        ignored,
        pendingHours: hours.size,
        pendingDays: days.size,
        perMemberRows: identity.persistable,
        pendingMemberDays: memberDays.size,
      };
    },

    flush(db, now = Math.floor(Date.now() / 1000)) {
      const currentHour = hourOf(now);

      db.transaction(() => {
        for (const [h, byChannel] of hours) {
          if (h > currentHour) continue;
          for (const [channelId, entry] of byChannel) {
            const delta = deltaFor(persistedHours, h, channelId, entry.messages);
            if (delta === null) continue;

            // Another process may already hold part of this hour (restart
            // inside the same hour), so add rather than replace. unique_authors
            // is per-channel distinct and cannot be merged across processes
            // without the sets, so it is a floor: keep the larger of the two.
            const prev = db.get(
              'SELECT messages, unique_authors FROM message_hour WHERE hour_ts = ? AND channel_id = ?',
              h,
              channelId,
            );

            db.run(
              `INSERT INTO message_hour(hour_ts, channel_id, messages, unique_authors)
               VALUES(?,?,?,?)
               ON CONFLICT(hour_ts, channel_id) DO UPDATE SET
                 messages = excluded.messages,
                 unique_authors = excluded.unique_authors`,
              h,
              channelId,
              (prev?.messages ?? 0) + delta,
              Math.max(prev?.unique_authors ?? 0, entry.authors.size),
            );
            markPersisted(persistedHours, h, channelId, entry.messages);
          }
        }

        for (const [d, byChannel] of days) {
          for (const [channelId, entry] of byChannel) {
            const delta = deltaFor(persistedDays, d, channelId, entry.messages);
            if (delta === null) continue;

            const prev = db.get(
              'SELECT messages, unique_authors, partial FROM message_day WHERE day_ts = ? AND channel_id = ?',
              d,
              channelId,
            );

            // The partial flag is sticky: once a day is known to have been
            // observed for only part of its span, a later process must not
            // claim otherwise by writing 0 back over it.
            const partial = Math.max(prev?.partial ?? 0, isPartialDay(d));

            let messages;
            if (!prev) {
              messages = entry.messages;
            } else if (prev.partial) {
              // Row was left incomplete by an earlier process: accumulate.
              messages = prev.messages + delta;
            } else {
              // This process observed the day from its start, so its running
              // total is the day's total. MAX keeps a double flush idempotent.
              messages = Math.max(prev.messages, entry.messages);
            }

            db.run(
              `INSERT INTO message_day(day_ts, channel_id, messages, unique_authors, partial)
               VALUES(?,?,?,?,?)
               ON CONFLICT(day_ts, channel_id) DO UPDATE SET
                 messages = excluded.messages,
                 unique_authors = excluded.unique_authors,
                 partial = excluded.partial`,
              d,
              channelId,
              messages,
              Math.max(prev?.unique_authors ?? 0, entry.authors.size),
              partial,
            );
            markPersisted(persistedDays, d, channelId, entry.messages);
          }
        }

        // MAX() rather than assignment: the in-memory set only grows within an
        // interval, so this is idempotent across retries and safe if a second
        // process ever writes the same bucket.
        for (const [h, set] of posterHours) {
          if (h > currentHour) continue;
          db.run(
            `INSERT INTO poster_hour(hour_ts, posters) VALUES(?,?)
             ON CONFLICT(hour_ts) DO UPDATE SET
               posters = MAX(poster_hour.posters, excluded.posters)`,
            h,
            set.size,
          );
        }

        for (const [d, set] of posterDays) {
          db.run(
            `INSERT INTO poster_day(day_ts, posters) VALUES(?,?)
             ON CONFLICT(day_ts) DO UPDATE SET
               posters = MAX(poster_day.posters, excluded.posters)`,
            d,
            set.size,
          );
        }

        // voice_s is deliberately absent from the insert so an ON CONFLICT row
        // written earlier by the voice collector keeps its seconds intact.
        for (const [h, byKey] of memberHours) {
          if (h > currentHour) continue;
          for (const [key, count] of byKey) {
            const delta = deltaFor(persistedMembers, h, key, count);
            if (delta === null) continue;

            const prev = db.get(
              'SELECT messages FROM member_hour WHERE hour_ts = ? AND user_hmac = ?',
              h,
              key,
            );

            db.run(
              `INSERT INTO member_hour(hour_ts, user_hmac, messages, voice_s)
               VALUES(?,?,?,0)
               ON CONFLICT(hour_ts, user_hmac) DO UPDATE SET
                 messages = excluded.messages`,
              h,
              key,
              (prev?.messages ?? 0) + delta,
            );
            markPersisted(persistedMembers, h, key, count);
          }
        }

        // Per-member day rows. Delta-based like the hour rows, but with no
        // partial-day accumulation: a restart can only undercount the day, and
        // the day's own `partial` flag on message_day is what the API reads to
        // mark retention measured on a partly observed day.
        for (const [d, byKey] of memberDays) {
          for (const [key, count] of byKey) {
            const delta = deltaFor(persistedMemberDays, d, key, count);
            if (delta === null) continue;
            addMemberDayMessages(db, { key, dayTs: d, delta });
            markPersisted(persistedMemberDays, d, key, count);
          }
        }
      });

      // Keep the trailing hour in RAM so a late flush can still correct it.
      for (const h of hours.keys()) if (h < currentHour - 3600) hours.delete(h);
      for (const d of days.keys()) if (d < bootDay - DAY) days.delete(d);
      for (const h of posterHours.keys()) if (h < currentHour - 3600) posterHours.delete(h);
      for (const h of memberHours.keys()) if (h < currentHour - 3600) memberHours.delete(h);
      for (const d of posterDays.keys()) if (d < bootDay - DAY) posterDays.delete(d);
      for (const d of memberDays.keys()) if (d < bootDay - DAY) memberDays.delete(d);

      // Pruned on a stricter schedule than the counters they mirror. Dropping a
      // "written" marker while its bucket is still in RAM would make the next
      // flush re-add the whole running total.
      for (const h of persistedHours.keys()) if (h < currentHour - 3 * 3600) persistedHours.delete(h);
      for (const h of persistedMembers.keys()) if (h < currentHour - 3 * 3600) persistedMembers.delete(h);
      for (const d of persistedDays.keys()) if (d < bootDay - 2 * DAY) persistedDays.delete(d);
      for (const d of persistedMemberDays.keys()) if (d < bootDay - 2 * DAY) persistedMemberDays.delete(d);
    },

    reset() {
      hours.clear();
      days.clear();
      posterHours.clear();
      posterDays.clear();
      memberHours.clear();
      memberDays.clear();
      persistedHours.clear();
      persistedDays.clear();
      persistedMembers.clear();
      persistedMemberDays.clear();
      received = 0;
      ignored = 0;
    },
  };
}
