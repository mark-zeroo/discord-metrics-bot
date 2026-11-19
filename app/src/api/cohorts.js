import { DAY, isoDate, dayOf, bucketStart, bucketLabel, iso, monthStart } from '../time.js';
import {
  STATUS,
  STATUS_LEGEND,
  countCell,
  isPublished,
  ratioCell,
  suppressionBlock,
  withheld,
} from './suppression.js';

/**
 * Cohort retention at D1 / D7 / D30.
 *
 * What is measured, precisely:
 *
 *   A cohort is every *membership span* whose join date falls in the same UTC day
 *   or week. Dn is the share of that cohort with at least one message or voice
 *   second on the UTC calendar day that is n days after the member's own join day.
 *   It is exact-day retention, not "returned at some point after day n": those are
 *   different questions and only one of them can be answered unambiguously by a
 *   per-day table.
 *
 * Three things make the numbers honest, and each of them is a place where a
 * simpler implementation would lie:
 *
 *   "Immature" is not zero. A cohort that joined four days ago has no D30 yet.
 *     Reporting 0 would read as "nobody came back after a month".
 *   "Unmeasured" is not zero. Per-member daily rows begin when this table was
 *     introduced, so a cohort older than that has no activity history at all —
 *     not an empty one.
 *   "Quiet" is not "unobserved". A day the collector was down and a day nobody
 *     posted both have no per-member rows; collector_day is what separates them.
 *
 * Every one of those, plus the suppression floor, comes back as a status on the
 * cell rather than a bare null, so a reader can tell a small number from a hidden
 * one from a missing one.
 */

export const RETENTION_PERIODS = [1, 7, 14, 30];

const PERIOD_LABEL = (p) => `d${p}`;

/** Exclusive end of the bucket a cohort key starts. */
function cohortEnd(key, cohort) {
  if (cohort === 'month') return monthStart(key + 32 * DAY);
  if (cohort === 'day') return key + DAY;
  return key + 7 * DAY;
}

export function retention(
  db,
  config,
  { window, cohort = 'week', periods = [1, 7, 30], limit = 12, ts = Math.floor(Date.now() / 1000) } = {},
) {
  const k = config.privacy.minCell;
  const legend = STATUS_LEGEND;

  if (config.privacy.perMemberCounters !== 'hmac') {
    return {
      available: false,
      reason:
        'PER_MEMBER_COUNTERS is off, so no per-member rows are stored and no cohort can be ' +
        'followed over time. This is a configuration state, not a quiet server.',
      what_would_help:
        'Set PER_MEMBER_COUNTERS=hmac with HMAC_KEY and let it collect: member_day and ' +
        'member_tenure start empty and fill forward from that point.',
      window: window.label,
      cohort,
      periods,
      status_legend: legend,
      quality: quality(db, config, ts),
    };
  }

  const today = dayOf(ts);
  const lastCompleteDay = today - DAY;
  const from = window.label === 'all' ? 0 : ts - window.seconds;

  // Daily activity exists only from the first member_day row. Cohorts older than
  // that are not "0 retained", they are unmeasurable, and the difference is the
  // whole point of the table.
  const activityFrom = db.get('SELECT MIN(day_ts) AS v FROM member_day')?.v ?? null;

  // Days the collector was alive. A day missing from this set was not observed.
  const observedDays = new Set(
    db.all('SELECT day_ts FROM collector_day WHERE day_ts >= ?', activityFrom ?? from).map((r) => r.day_ts),
  );

  // Partly observed days still count as observed, but a member active only during
  // the unobserved part of one is invisible. The cell says so instead of quietly
  // rounding down.
  const partialDays = new Set(
    db
      .all(
        `SELECT day_ts FROM message_day WHERE partial = 1
         UNION SELECT day_ts FROM voice_day WHERE partial = 1`,
      )
      .map((r) => r.day_ts),
  );

  const spans = db.all(
    `SELECT user_hmac, joined_ts, left_ts FROM member_tenure
      WHERE joined_ts >= ? AND joined_ts <= ?
      ORDER BY joined_ts ASC`,
    Math.max(from, 0),
    ts,
  );

  const anySpans = db.get('SELECT COUNT(*) AS n FROM member_tenure')?.n ?? 0;

  if (spans.length === 0) {
    return {
      available: true,
      window: window.label,
      cohort,
      periods,
      cohorts: [],
      pooled: null,
      empty_reason:
        anySpans === 0
          ? {
              status: STATUS.no_data,
              detail:
                'No membership spans have been recorded yet. Either member_day/member_tenure ' +
                'collection has not started (this table is new), or the tenure backfill has not ' +
                'finished its first pass. This is not "no members".',
            }
          : {
              status: STATUS.unmeasured,
              detail: `Membership spans exist, but none joined inside this ${window.label} window.`,
            },
      status_legend: legend,
      suppression: suppressionBlock({ k, cells: [] }),
      caveats: caveats({ config, activityFrom, today }),
      quality: quality(db, config, ts),
    };
  }

  // Cohorts, newest last. Bucketing happens in JS because bucketStart is the one
  // definition of a week/month boundary everywhere else in this codebase.
  const byCohort = new Map();
  for (const span of spans) {
    const key = bucketStart(span.joined_ts, cohort);
    let list = byCohort.get(key);
    if (!list) {
      list = [];
      byCohort.set(key, list);
    }
    list.push(span);
  }

  const allKeys = [...byCohort.keys()].sort((a, b) => a - b);
  const keptKeys = allKeys.slice(-limit);
  const truncated = allKeys.length > keptKeys.length;

  // One query for every span in the kept cohorts, with a LEFT JOIN so a member
  // with no activity still appears: they are the denominator, and dropping them
  // would turn retention into "share of active members who were active".
  const maxPeriod = Math.max(...periods);
  const boundsFrom = keptKeys[0];
  // Exclusive: a span that joined in the next bucket is a different cohort and its
  // activity must not be loaded into this one's denominator.
  const boundsTo = Math.min(ts + 1, cohortEnd(keptKeys[keptKeys.length - 1], cohort));

  const rows = db.all(
    `SELECT t.user_hmac AS user_hmac,
            t.joined_ts  AS joined_ts,
            t.left_ts    AS left_ts,
            md.day_ts    AS day_ts
       FROM member_tenure t
       LEFT JOIN member_day md
         ON md.user_hmac = t.user_hmac
        AND md.day_ts >= (t.joined_ts / ${DAY}) * ${DAY}
        AND md.day_ts <= (t.joined_ts / ${DAY}) * ${DAY} + ?
        AND (t.left_ts IS NULL OR md.day_ts <= (t.left_ts / ${DAY}) * ${DAY})
      WHERE t.joined_ts >= ? AND t.joined_ts < ?
      ORDER BY t.joined_ts ASC`,
    maxPeriod * DAY,
    boundsFrom,
    boundsTo,
  );

  // Group the join into per-span activity offsets, keyed by span identity rather
  // than by pseudonym: a rejoin is a second span for the same person, and its D1
  // must not inherit the first span's activity.
  const spanKey = (r) => `${r.user_hmac}:${r.joined_ts}`;
  const activity = new Map();
  for (const row of rows) {
    const key = spanKey(row);
    if (!activity.has(key)) activity.set(key, new Set());
    if (row.day_ts !== null) activity.get(key).add(Math.round((row.day_ts - dayOf(row.joined_ts)) / DAY));
  }

  const cells = [];
  const cohorts = keptKeys.map((key) => {
    const members = byCohort.get(key);
    const size = members.length;
    const sizeCell = countCell(size, { k, base: size });
    const sizePublished = isPublished(sizeCell);

    const entry = {
      cohort: bucketLabel(key, cohort),
      starts: isoDate(key),
      members: sizeCell,
      // Per-member counts inside a cohort smaller than k are all withheld, but the
      // row stays so a reader can see that a cohort existed and why it is empty:
      // deleting the row is how "suppressed" starts to look like "no joiners".
      suppressed_row: !sizePublished,
    };

    for (const p of periods) {
      const label = PERIOD_LABEL(p);
      const retained = [];
      let measured = 0;
      let immature = 0;
      let unmeasured = 0;
      let leftBefore = 0;
      let partial = false;

      for (const member of members) {
        const joinedDay = dayOf(member.joined_ts);
        const observationDay = joinedDay + p * DAY;

        if (observationDay > lastCompleteDay) {
          immature += 1;
          continue;
        }
        if (activityFrom === null || observationDay < activityFrom || !observedDays.has(observationDay)) {
          unmeasured += 1;
          continue;
        }

        measured += 1;
        if (partialDays.has(observationDay)) partial = true;
        if (member.left_ts !== null && dayOf(member.left_ts) < observationDay) {
          // They were gone before the day in question. Counting them as "not
          // retained" is the honest reading (they did not come back), but the
          // count is surfaced so the rate is not mistaken for pure disengagement.
          leftBefore += 1;
        }
        if (activity.get(spanKey(member))?.has(p)) retained.push(member);
      }

      let status;
      let retainedCell;
      let measuredCell;
      if (measured === 0) {
        status = immature > 0 && unmeasured === 0 ? STATUS.immature : STATUS.unmeasured;
        retainedCell = withheld(status, {
          reason: immature > 0 && unmeasured === 0 ? 'period_not_elapsed' : 'observation_day_not_collected',
        });
        measuredCell = withheld(status);
      } else {
        measuredCell = countCell(measured, { k });
        retainedCell = countCell(retained.length, { k, base: measured });
        status = retainedCell.status;
      }

      const rateCell = ratioCell(retainedCell, measuredCell);
      entry[label] = {
        status: rateCell.status,
        rate: rateCell.value,
        retained: retainedCell.value,
        measured: measuredCell.value,
        // Only a day cohort has one observation day. A weekly cohort's members
        // each have their own day n, so a single label here would be a false
        // precision; the not_yet_due / not_observed counts carry what matters.
        observed_day: cohort === 'day' ? isoDate(dayOf(members[0].joined_ts) + p * DAY) : null,
        // Every one of these is a count of people, so every one is guarded. The
        // breakdown matters: "not due yet" and "not observed" are different
        // reasons for a missing rate and only one of them resolves with time.
        left_before_day: countCell(leftBefore, { k, base: size }),
        // A boolean survives the floor where the count does not, and it is what the
        // reader needs to avoid blaming disengagement for a departure. It says
        // "some", never how many.
        left_before_day_any: leftBefore > 0,
        partial_day: partial,
        not_yet_due: countCell(immature, { k, base: size }),
        not_observed: countCell(unmeasured, { k, base: size }),
      };
      // Everything that is a count of people goes into the suppression summary,
      // including the explanatory ones: a block that reports 2 withheld cells while
      // the row shows five is a reason to distrust the whole table.
      cells.push(
        retainedCell,
        measuredCell,
        entry[label].left_before_day,
        entry[label].not_yet_due,
        entry[label].not_observed,
      );
    }

    return entry;
  });

  // Pooled rates: an average over the cohorts that published this period.
  //
  // Deliberately *only* the published ones. A pooled figure computed over a
  // withheld cohort would recover it by subtraction, but a pooled figure over the
  // published cohorts recovers nothing: it is already derivable from them. The
  // count of cohorts left out travels with the number so a narrow pool is never
  // mistaken for the whole history.
  const pooled = {};
  for (const p of periods) {
    const label = PERIOD_LABEL(p);
    const included = cohorts.filter((c) => c[label] && c[label].status === STATUS.published);
    const excluded = cohorts.length - included.length;
    // Why a cohort is out of the pool matters: "immature" resolves next month and
    // "suppressed" never does. Folding them into one count would make a young
    // table look like a heavily censored one.
    const excludedByStatus = {};
    for (const c of cohorts) {
      const status = c[label]?.status ?? STATUS.no_data;
      if (status === STATUS.published) continue;
      excludedByStatus[status] = (excludedByStatus[status] ?? 0) + 1;
    }
    let retained = 0;
    let measured = 0;
    for (const c of included) {
      retained += c[label].retained;
      measured += c[label].measured;
    }

    if (included.length === 0 || measured === 0) {
      pooled[label] = {
        status: STATUS.withheld_suppression,
        rate: null,
        retained: null,
        measured: null,
        cohorts_included: 0,
        cohorts_excluded: excluded,
        excluded_by_status: excludedByStatus,
        reason:
          'every cohort for this period is withheld or unmeasurable, so there is nothing to pool ' +
          'without republishing a withheld cell',
      };
    } else {
      pooled[label] = {
        status: STATUS.published,
        rate: Number((retained / measured).toFixed(3)),
        retained,
        measured,
        cohorts_included: included.length,
        cohorts_excluded: excluded,
        excluded_by_status: excludedByStatus,
      };
    }
  }

  return {
    available: true,
    window: window.label,
    cohort,
    periods,
    // Oldest first, like every other series in this API, so "the trend" reads left
    // to right. A capped list keeps the newest cohorts, and the flags say so.
    cohorts,
    cohorts_total: allKeys.length,
    cohorts_truncated: truncated,
    capped_to_newest: truncated ? keptKeys.length : null,
    pooled,
    basis: {
      cohort_by: cohort,
      retention_definition:
        'active (at least one message or voice second) on the UTC day that is n days after ' +
        "the member's own join day, divided by members of the cohort whose nth day has been " +
        'observed. Exact-day retention, not cumulative.',
      join_date_source: 'Discord joinedAt, backfilled once and recorded live thereafter',
      activity_source: 'member_day (per-member, daily, hmac mode only)',
      activity_from: activityFrom === null ? null : isoDate(activityFrom),
      last_complete_day: isoDate(lastCompleteDay),
      pooled:
        'pooled rates cover only the cohorts that published that period (cohorts_included) and ' +
        'say how many were left out (cohorts_excluded); a total over a withheld cohort would ' +
        'recover it by subtraction.',
    },
    suppression: suppressionBlock({ k, cells }),
    status_legend: legend,
    caveats: caveats({ config, activityFrom, today }),
    quality: quality(db, config, ts),
  };
}

function caveats({ config, activityFrom, today }) {
  return [
    'Dn means active on the single UTC day n days after joining. It is not "returned at any point after day n"; a member who went quiet for a month and came back does not count as D30.',
    'Members who left the server before the observation day stay in the denominator and count as not retained. left_before_day says how many: without it an active core leaving reads as ordinary disengagement.',
    activityFrom === null
      ? 'No per-member daily rows exist yet, so nothing is measurable. This table starts empty on an upgrade and fills forward.'
      : `Per-member daily activity begins ${isoDate(activityFrom)}. Cohorts that joined earlier show unmeasured cells for days before that, not zero retention.`,
    'A day the collector was down is reported as unmeasured rather than as a day nobody was active. Days the collector only partly observed are flagged partial_day, and their retention is a lower bound.',
    `Cohorts smaller than ${config.privacy.minCell} are withheld with a status, and so are counts whose complement is: "19 of 20 came back" names the one who did not.`,
    'Departed members are invisible unless this collector saw them leave, so a cohort can only be built from members whose join date is known. Anyone who joined and left before install is absent from every cohort.',
    'Messages from EXCLUDED_ROLE_IDS are not counted anywhere, so a member whose only activity is in an excluded role looks inactive here.',
    'Time is UTC. A join at 23:50 UTC has its D1 start the next UTC day, which is not the member\'s local next day.',
  ];
}

function quality(db, config, ts) {
  return {
    generated_at: iso(ts),
    per_member_counters: config.privacy.perMemberCounters,
    min_cell: config.privacy.minCell,
    retention: {
      hourly_days: config.storage.retentionHourlyDays,
      daily_days: config.storage.retentionDailyDays,
    },
  };
}
