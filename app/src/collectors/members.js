import { DAY, HOUR, hourOf, dayOf } from '../time.js';

/**
 * Joins, leaves and the periodic member/boost snapshot.
 *
 * Joins and leaves are counter deltas, never a list of who — the member object
 * is inspected for `.user.bot` and nothing else is retained. A leave is a
 * counter increment; the departing member's identity is gone before the next
 * statement runs.
 */
export function createMemberCollector() {
  /** hour -> {joins, leaves, members, bots} */
  const hours = new Map();
  const days = new Map();

  const bootTs = Math.floor(Date.now() / 1000);
  const bootDay = dayOf(bootTs);

  let lastCounts = { members: null, bots: null };

  function bump(map, key) {
    let e = map.get(key);
    if (!e) {
      e = { joins: 0, leaves: 0, members: null, bots: null };
      map.set(key, e);
    }
    return e;
  }

  function note(ts, field, isBot) {
    // Bots churn constantly and would pollute the growth curve; they appear in
    // the snapshot counts instead, where they are labelled as bots.
    if (isBot) return;
    bump(hours, hourOf(ts))[field] += 1;
    bump(days, dayOf(ts))[field] += 1;
  }

  return {
    name: 'members',

    onJoin(member, { now = Math.floor(Date.now() / 1000) } = {}) {
      note(now, 'joins', member.user?.bot === true);
    },

    onLeave(member, { now = Math.floor(Date.now() / 1000) } = {}) {
      note(now, 'leaves', member.user?.bot === true);
    },

    /**
     * Called after a successful REST count poll. Persists the total member
     * count against the current hour so the growth series has an anchor even
     * if no join/leave happened.
     */
    noteCounts({ members, bots, now = Math.floor(Date.now() / 1000) }) {
      if (Number.isInteger(members)) {
        bump(hours, hourOf(now)).members = members;
        bump(days, dayOf(now)).members = members;
        lastCounts.members = members;
      }
      if (Number.isInteger(bots)) {
        bump(hours, hourOf(now)).bots = bots;
        bump(days, dayOf(now)).bots = bots;
        lastCounts.bots = bots;
      }
    },

    stats() {
      return { ...lastCounts, pendingHours: hours.size };
    },

    flush(db, now = Math.floor(Date.now() / 1000)) {
      const currentHour = hourOf(now);

      db.transaction(() => {
        for (const [h, e] of hours) {
          if (h > currentHour) continue;
          if (e.joins === 0 && e.leaves === 0 && e.members === null) continue;
          // Counters are monotonic within the interval, so last write wins.
          db.run(
            `INSERT INTO growth_hour(hour_ts, joins, leaves, members, bots)
             VALUES(?,?,?,?,?)
             ON CONFLICT(hour_ts) DO UPDATE SET
               joins = MAX(growth_hour.joins, excluded.joins),
               leaves = MAX(growth_hour.leaves, excluded.leaves),
               members = COALESCE(excluded.members, growth_hour.members),
               bots = COALESCE(excluded.bots, growth_hour.bots)`,
            h,
            e.joins,
            e.leaves,
            e.members,
            e.bots,
          );
        }

        for (const [d, e] of days) {
          db.run(
            `INSERT INTO growth_day(day_ts, joins, leaves, members, bots, partial)
             VALUES(?,?,?,?,?,?)
             ON CONFLICT(day_ts) DO UPDATE SET
               joins = MAX(growth_day.joins, excluded.joins),
               leaves = MAX(growth_day.leaves, excluded.leaves),
               members = COALESCE(excluded.members, growth_day.members),
               bots = COALESCE(excluded.bots, growth_day.bots)`,
            d,
            e.joins,
            e.leaves,
            e.members,
            e.bots,
            d === bootDay && bootTs > d ? 1 : 0,
          );
        }
      });

      for (const h of hours.keys()) if (h < currentHour - HOUR) hours.delete(h);
      for (const d of days.keys()) if (d < bootDay - DAY) days.delete(d);
    },

    reset() {
      hours.clear();
      days.clear();
    },
  };
}
