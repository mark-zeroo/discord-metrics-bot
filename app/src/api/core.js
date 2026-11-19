import {
  DAY,
  iso,
  isoDate,
  dayOf,
  bucketStart,
  bucketLabel,
  weekStart,
  monthStart,
} from '../time.js';
import {
  STATUS,
  STATUS_LEGEND,
  countCell,
  isPublished,
  published,
  ratioCell,
  suppressPartition,
  suppressionBlock,
} from './suppression.js';

/**
 * Core concentration over time, and what happens to the core.
 *
 * "Core" is the top `share` of *active* members by message count in a period, so
 * the threshold moves with activity rather than naming a fixed list of people.
 * That is on purpose: a fixed list would be a per-member league table, and the
 * point of this endpoint is a shape, not a ranking.
 *
 * Two things it refuses to do:
 *
 *   Report concentration for a period with fewer than k active members. "One
 *     member wrote 60% of messages" on a period with three active members is a
 *     description of a person, not of a community.
 *   Call a direction from two periods. Concentration is noisy week to week; the
 *     trend block needs coreMinPeriodsForTrend published periods behind it and
 *     says `insufficient_periods` otherwise.
 *
 * Core churn needs one caveat that the numbers cannot express on their own: the
 * core is a fixed *fraction*, so some turnover is guaranteed even if nobody
 * changes behaviour. `stayed_core` is therefore split from `left_core_active`
 * (slipped out of the top fifth but still here) and `left_core_inactive` (went
 * quiet), and the last of those is the one that means something.
 */

const BANDS = [
  ['1-9', (n) => n >= 1 && n < 10],
  ['10-49', (n) => n >= 10 && n < 50],
  ['50-199', (n) => n >= 50 && n < 200],
  ['200-999', (n) => n >= 200 && n < 1000],
  ['1000+', (n) => n >= 1000],
];

function gini(descending) {
  const v = [...descending].reverse();
  const n = v.length;
  if (n === 0) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  if (sum === 0) return null;
  let cum = 0;
  for (let i = 1; i <= n; i += 1) cum += i * v[i - 1];
  return Number(((2 * cum) / (n * sum) - (n + 1) / n).toFixed(3));
}

/**
 * The most recent *complete* period, as a bucket start.
 *
 * The current week is not finished, and including it would compare a partial
 * period against complete ones — which reads as a collapse in engagement every
 * Monday morning. The day/month variants are the same rule.
 */
export function lastCompletePeriodStart(ts, bucket) {
  switch (bucket) {
    case 'day':
      return dayOf(ts) - DAY;
    case 'month':
      return monthStart(monthStart(ts) - DAY);
    case 'week':
    default:
      return weekStart(ts) - 7 * DAY;
  }
}

function periodEnd(start, bucket) {
  if (bucket === 'month') return monthStart(start + 32 * DAY);
  if (bucket === 'day') return start + DAY;
  return start + 7 * DAY;
}

export function coreConcentration(
  db,
  config,
  { window, bucket = 'week', share = config?.analytics?.coreShare ?? 0.2, ts = Math.floor(Date.now() / 1000) } = {},
) {
  const k = config.privacy.minCell;
  const legend = STATUS_LEGEND;
  const minPeriodsForTrend = config.analytics.coreMinPeriodsForTrend;

  if (config.privacy.perMemberCounters !== 'hmac') {
    return {
      available: false,
      reason:
        'PER_MEMBER_COUNTERS is off, so there are no per-member rows and no core to describe. ' +
        'This is a configuration state, not a quiet server.',
      what_would_help: 'Set PER_MEMBER_COUNTERS=hmac with HMAC_KEY and let member_day fill forward.',
      window: window.label,
      bucket,
      share,
      periods: [],
      transitions: [],
      status_legend: legend,
      quality: quality(db, config, ts, share),
    };
  }

  const activityFrom = db.get('SELECT MIN(day_ts) AS v FROM member_day')?.v ?? null;
  if (activityFrom === null) {
    return {
      available: true,
      window: window.label,
      bucket,
      share,
      periods: [],
      transitions: [],
      trend: { status: STATUS.no_data, detail: 'No per-member daily rows have been collected yet.' },
      status_legend: legend,
      suppression: suppressionBlock({ k, cells: [] }),
      caveats: caveats(config),
      quality: quality(db, config, ts, share),
    };
  }

  // Periods to report: the newest complete ones that fit the requested window.
  const from = window.label === 'all' ? activityFrom : Math.max(ts - window.seconds, activityFrom);
  const newest = lastCompletePeriodStart(ts, bucket);
  const starts = [];
  for (let i = 0; i < config.analytics.corePeriods; i += 1) {
    const start = bucketStart(newest - i * (bucket === 'month' ? 32 * DAY : bucket === 'day' ? DAY : 7 * DAY), bucket);
    if (periodEnd(start, bucket) <= from) break;
    starts.push(start);
  }
  starts.reverse();
  const periodFrom = starts.length ? starts[0] : newest;
  const periodTo = starts.length ? periodEnd(starts[starts.length - 1], bucket) : periodEnd(newest, bucket);

  if (starts.length === 0) {
    // Two very different reasons produce an empty list, and saying "no complete
    // period falls inside this window" for both sent a reader looking at their
    // window when the answer was "wait until Monday".
    const windowStart = window.label === 'all' ? activityFrom : ts - window.seconds;
    const periodSpan = bucket === 'month' ? 32 * DAY : bucket === 'day' ? DAY : 7 * DAY;
    const completeExists = periodEnd(newest, bucket) > windowStart;
    const firstMeasurable = bucketStart(activityFrom + periodSpan, bucket);
    return {
      available: true,
      window: window.label,
      bucket,
      share,
      periods: [],
      transitions: [],
      trend: completeExists
        ? {
            status: STATUS.immature,
            detail:
              `Per-member activity begins ${isoDate(activityFrom)}, which falls inside the ` +
              `${bucket} that is still running. The first complete period with per-member data is ` +
              `${bucketLabel(firstMeasurable, bucket)}, measurable from ` +
              `${isoDate(periodEnd(firstMeasurable, bucket))}.`,
            first_measurable_period: bucketLabel(firstMeasurable, bucket),
            measurable_from: isoDate(periodEnd(firstMeasurable, bucket)),
          }
        : {
            status: STATUS.unmeasured,
            detail:
              `This window is shorter than one complete ${bucket}, so there is no period to ` +
              'describe regardless of how much activity it contains.',
          },
      status_legend: legend,
      suppression: suppressionBlock({ k, cells: [] }),
      caveats: caveats(config),
      quality: quality(db, config, ts, share),
    };
  }

  const rows = db.all(
    `SELECT user_hmac, day_ts, messages FROM member_day
      WHERE day_ts >= ? AND day_ts < ? AND messages > 0`,
    periodFrom,
    periodTo,
  );

  // periodStart -> Map<hmac, messages>
  const perPeriod = new Map(starts.map((s) => [s, new Map()]));
  for (const row of rows) {
    const bucketOf = bucketStart(row.day_ts, bucket);
    const target = perPeriod.get(bucketOf);
    if (!target) continue;
    target.set(row.user_hmac, (target.get(row.user_hmac) ?? 0) + row.messages);
  }

  // Members whose membership span ended inside the window after each period: used
  // to split "went quiet" from "left the server". Only spans this collector saw
  // close are here; historical departures are invisible and are not guessed at.
  const departures = db.all(
    `SELECT user_hmac, left_ts FROM member_tenure
      WHERE left_ts IS NOT NULL AND left_ts >= ? AND left_ts < ?`,
    periodFrom,
    periodTo,
  );
  const leftByPeriod = new Map(starts.map((s) => [s, new Set()]));
  for (const d of departures) {
    const bucketOf = bucketStart(d.left_ts, bucket);
    leftByPeriod.get(bucketOf)?.add(d.user_hmac);
  }

  const cells = [];
  const periods = [];
  const coreSets = new Map();

  for (const start of starts) {
    const counts = perPeriod.get(start);
    const messages = [...counts.values()].sort((a, b) => b - a);
    const active = messages.length;
    const total = messages.reduce((a, b) => a + b, 0);
    const coreSize = active > 0 ? Math.max(1, Math.ceil(active * share)) : 0;

    const core = new Set(
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, coreSize)
        .map(([key]) => key),
    );
    coreSets.set(start, core);

    // A period nobody posted in is a measured zero, not a withheld one: publishing
    // 0 here identifies nobody, and calling it "suppressed" would make a quiet week
    // look like a policy decision.
    const empty = active === 0;
    const activeCell = empty ? published(0) : countCell(active, { k, base: active });
    const coreCell = empty ? published(0) : countCell(coreSize, { k, base: active });
    const publishable = empty || (isPublished(activeCell) && isPublished(coreCell));
    cells.push(activeCell, coreCell);

    const entry = {
      period: bucketLabel(start, bucket),
      starts: isoDate(start),
      ends: isoDate(periodEnd(start, bucket) - DAY),
      status: empty ? STATUS.no_data : publishable ? STATUS.published : STATUS.suppressed_small_count,
      active_members: activeCell,
      core_size: coreCell,
      // The fraction that defined the core, so a reader can see why core_size is
      // what it is without reverse-engineering ceil(active * share).
      core_share_used: share,
    };

    if (empty) {
      entry.reason = 'No member activity was recorded in this period: a measured zero, not a withheld figure.';
    } else if (!publishable) {
      // Name the cell that actually failed. Blaming the active count when 25 people
      // were active and only the 5-member core was too small sends the reader to
      // the wrong knob, and reads as a contradiction in the same payload.
      entry.reason = !isPublished(activeCell)
        ? `${active} active member${active === 1 ? ' is' : 's are'} below the anonymity floor of ${k}: ` +
          'a concentration figure would describe those people, not a community.'
        : `The core is ${coreSize} of ${active} active members, which is below the anonymity ` +
          `floor of ${k}: a core that small can be named person by person.`;
    } else {
      const topN = Math.max(1, Math.ceil(active * 0.1));
      const topShare = messages.slice(0, topN).reduce((a, b) => a + b, 0) / total;

      let cum = 0;
      let membersFor80 = active;
      for (let i = 0; i < active; i += 1) {
        cum += messages[i];
        if (cum >= total * 0.8) {
          membersFor80 = i + 1;
          break;
        }
      }
      const median =
        active % 2 === 1
          ? messages[(active - 1) / 2]
          : (messages[active / 2 - 1] + messages[active / 2]) / 2;
      const coreMessages = [...core].reduce((acc, key) => acc + (counts.get(key) ?? 0), 0);

      // members_for_80 is a count of people: guard it like one. It is the most
      // identifying concentration figure on a small server ("two people write 80%")
      // because it names a group of two.
      const m80 = countCell(membersFor80, { k, base: active });
      cells.push(m80);

      entry.concentration = {
        members_for_80_percent_of_messages: m80,
        share_of_messages_from_top_10_percent: Number(topShare.toFixed(3)),
        share_of_messages_from_core: Number((coreMessages / total).toFixed(3)),
        median_messages_per_active_member: median,
        gini: gini(messages),
        distribution: suppressPartition({
          k,
          counts: BANDS.map(([label, test]) => ({
            key: label,
            count: messages.filter(test).length,
          })),
          total: active,
        }).cells.map((c) => ({ band: c.key, members: c })),
      };
      // The share of messages from the core is a ratio of a per-person sum to a
      // total; it is only as safe as the cells it is built from, so it inherits
      // the period's status above.
    }

    periods.push(entry);
  }

  // ------------------------------------------------------------- transitions
  const transitions = [];
  for (let i = 1; i < starts.length; i += 1) {
    const prevStart = starts[i - 1];
    const start = starts[i];
    const prev = coreSets.get(prevStart);
    const now = coreSets.get(start);
    const nowAll = perPeriod.get(start);
    const prevAll = perPeriod.get(prevStart);
    if (prev.size === 0 || now.size === 0) continue;

    const stayed = [...prev].filter((key) => now.has(key)).length;
    const slipped = [...prev].filter((key) => !now.has(key) && nowAll.has(key)).length;
    const gone = [...prev].filter((key) => !nowAll.has(key)).length;
    // Confirmed departures are a subset of "gone": a member who left the server
    // did not merely go quiet, and conflating the two overstates disengagement.
    const leftServer = [...prev].filter(
      (key) => !nowAll.has(key) && leftByPeriod.get(start)?.has(key),
    ).length;
    const wentQuiet = gone - leftServer;
    const entered = [...now].filter((key) => !prev.has(key)).length;

    const prevCoreCell = countCell(prev.size, { k, base: prevAll.size });
    const stayedCell = countCell(stayed, { k, base: prev.size });
    const slippedCell = countCell(slipped, { k, base: prev.size });
    const goneCell = countCell(gone, { k, base: prev.size });
    const quietCell = countCell(wentQuiet, { k, base: prev.size });
    const leftCell = countCell(leftServer, { k, base: prev.size });
    const enteredCell = countCell(entered, { k, base: nowAll.size });
    cells.push(prevCoreCell, stayedCell, slippedCell, goneCell, quietCell, leftCell, enteredCell);

    const retentionRate = ratioCell(stayedCell, prevCoreCell);
    // Dropout is "stopped being active at all", which is the sum of went-quiet and
    // left. Derived from the combined cell so the denominator and numerator are
    // withheld together when they are too small.
    const dropoutRate = ratioCell(goneCell, prevCoreCell);

    transitions.push({
      from: bucketLabel(prevStart, bucket),
      to: bucketLabel(start, bucket),
      status: retentionRate.status,
      core_previous: prevCoreCell,
      core_now: countCell(now.size, { k, base: nowAll.size }),
      stayed_core: stayedCell,
      left_core_active: slippedCell,
      left_core_inactive: quietCell,
      // A confirmed departure is a different event from going quiet, and only the
      // confirmed ones are counted here: this collector cannot see a leave it was
      // not running for.
      left_server_confirmed: leftCell,
      left_core_gone: goneCell,
      joined_core: enteredCell,
      core_retention_rate: retentionRate,
      core_dropout_rate: dropoutRate,
      dropped_from_core_rate: ratioCell(slippedCell, prevCoreCell),
      note:
        'The core is a fixed fraction of active members, so some turnover is guaranteed even if ' +
        'nobody changes behaviour. left_core_active is a slip in rank; left_core_inactive is the ' +
        'signal worth acting on.',
    });
  }

  // ------------------------------------------------------------------- trend
  // Named `publishedPeriods`, not `published`: the latter shadows the imported
  // cell constructor in this scope and every use of it above dies in the TDZ.
  const publishedPeriods = periods.filter((p) => p.status === STATUS.published && p.concentration);
  let trend;
  if (publishedPeriods.length < minPeriodsForTrend) {
    trend = {
      status: publishedPeriods.length === 0 ? STATUS.suppressed_small_count : STATUS.unmeasured,
      periods_published: publishedPeriods.length,
      periods_needed: minPeriodsForTrend,
      detail:
        `A direction needs at least ${minPeriodsForTrend} publishable periods; this window has ` +
        `${publishedPeriods.length}. Weekly concentration moves too much for two points to mean anything.`,
    };
  } else {
    const half = Math.max(1, Math.floor(publishedPeriods.length / 2));
    const mean = (arr, pick) => arr.reduce((acc, p) => acc + pick(p), 0) / arr.length;
    const giniEarly = mean(publishedPeriods.slice(0, half), (p) => p.concentration.gini);
    const giniLate = mean(publishedPeriods.slice(-half), (p) => p.concentration.gini);
    const topEarly = mean(publishedPeriods.slice(0, half), (p) => p.concentration.share_of_messages_from_top_10_percent);
    const topLate = mean(publishedPeriods.slice(-half), (p) => p.concentration.share_of_messages_from_top_10_percent);
    const direction = (delta, threshold) =>
      delta > threshold ? 'more_concentrated' : delta < -threshold ? 'less_concentrated' : 'flat';
    trend = {
      status: STATUS.published,
      periods_compared: publishedPeriods.length,
      method: `mean of the first ${half} periods vs the last ${half} published periods`,
      gini: {
        early: Number(giniEarly.toFixed(3)),
        late: Number(giniLate.toFixed(3)),
        delta: Number((giniLate - giniEarly).toFixed(3)),
        direction: direction(giniLate - giniEarly, 0.02),
      },
      top_10_percent_share: {
        early: Number(topEarly.toFixed(3)),
        late: Number(topLate.toFixed(3)),
        delta: Number((topLate - topEarly).toFixed(3)),
        direction: direction(topLate - topEarly, 0.02),
      },
      note: 'A rising Gini means messaging is concentrating in fewer members, not that volume grew.',
    };
  }

  return {
    available: true,
    window: window.label,
    bucket,
    share,
    periods,
    transitions,
    latest_transition: transitions.length ? transitions[transitions.length - 1] : null,
    trend,
    definition: {
      core:
        `the top ${share} of active members by messages in each ${bucket}, at least one member`,
      active: 'sent at least one message in the period',
      churn_window: 'consecutive periods, so a member absent for one period can return in the next',
      activity_source: 'member_day (per-member, daily, hmac mode only)',
      activity_from: isoDate(activityFrom),
      identity: 'pseudonymous HMAC, and churn is measured per person, not per membership span',
    },
    suppression: suppressionBlock({ k, cells }),
    status_legend: legend,
    caveats: caveats(config),
    quality: quality(db, config, ts, share),
  };
}

function caveats(config) {
  return [
    'Core membership is defined by a fixed fraction of active members, so rank turnover happens even when nobody changes behaviour. Read left_core_inactive (went silent) as the churn signal, not left_core_active.',
    'Per-member activity begins when member_day collection starts, so periods before that are absent rather than empty.',
    'A member who leaves and rejoins keeps one pseudonym, so their activity across both memberships is summed here. Cohort retention deliberately does not do this — it keys on membership spans.',
    'A departure is only known when this collector saw it. left_server_confirmed is a floor, and a member who left while the bot was down appears as left_core_inactive.',
    `Periods with fewer than ${config.privacy.minCell} active members are withheld: concentration on a handful of people describes those people.`,
    'Messages from EXCLUDED_ROLE_IDS are not counted, so a member whose only activity is in an excluded role looks inactive.',
  ];
}

function quality(db, config, ts, share = config.analytics.coreShare) {
  return {
    generated_at: iso(ts),
    per_member_counters: config.privacy.perMemberCounters,
    min_cell: config.privacy.minCell,
    // The share actually used for this request, not the configured default: a
    // caller asking for 0.3 was getting share: 0.3 at the top level and
    // core_share: 0.2 here, two numbers for one request.
    core_share: share,
    core_periods: config.analytics.corePeriods,
  };
}
