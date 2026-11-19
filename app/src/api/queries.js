import { DAY, HOUR, iso, isoDate, rollup, bucketLabel, bucketStart, dayOf, hourOf } from '../time.js';
import { ParamError } from './params.js';

/**
 * All read paths live here. Every statement is a fixed string with bound
 * parameters — there is no query text built from caller input, so the whole
 * class of injection bugs is designed out rather than filtered.
 */

const now = () => Math.floor(Date.now() / 1000);

function sourceFor({ window, bucket, retentionHourlyDays }) {
  if (bucket !== 'hour') return { table: 'day', step: DAY };
  if (window.label === 'all') {
    throw new ParamError('bucket=hour is not available for window=all; use bucket=day');
  }
  if (window.seconds > retentionHourlyDays * DAY) {
    throw new ParamError(
      `bucket=hour is only retained for ${retentionHourlyDays} days; use bucket=day`,
    );
  }
  return { table: 'hour', step: HOUR };
}

function cutoff(window, ts) {
  return window.label === 'all' ? 0 : ts - window.seconds;
}

/**
 * How many buckets the window spans versus how many carry data.
 *
 * Series are built from rows that exist, and a bucket with no messages has no row
 * — so the array is sparse by construction. That is the honest shape (a missing
 * row is "nothing happened here", not a fabricated zero), but it is ambiguous to
 * a reader: with no density numbers, "7d by hour" returning 90 points instead of
 * 168 looks like a truncated response, and a silent stretch in the middle of the
 * series makes two distant days look adjacent.
 */
function seriesMeta({ window, bucket, from, ts, returned }) {
  if (window.label === 'all' || from === 0) {
    return {
      bucket,
      expected_buckets: null,
      returned_buckets: returned,
      note: 'Buckets with no activity are omitted, not zero-filled.',
    };
  }

  let expected;
  if (bucket === 'week' || bucket === 'month') {
    // Week and month buckets are floor-aligned groups, so a window that starts
    // mid-week still produces a bucket for that week: count distinct group keys.
    const first = bucketStart(from, bucket);
    const last = bucketStart(ts, bucket);
    if (bucket === 'month') {
      const a = new Date(first * 1000);
      const b = new Date(last * 1000);
      expected = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
    } else {
      expected = Math.floor((last - first) / (7 * DAY)) + 1;
    }
  } else {
    // Hour and day rows are filtered on the raw timestamp rather than grouped,
    // so a partial bucket at each end counts once: ceil, not inclusive count.
    const size = bucket === 'hour' ? HOUR : DAY;
    expected = Math.ceil((ts - from) / size);
  }

  return {
    bucket,
    expected_buckets: expected,
    returned_buckets: returned,
    note: 'Buckets with no activity are omitted, not zero-filled, so returned_buckets can be lower than expected_buckets.',
  };
}

/**
 * Channel and guild names are admin-editable free text, which makes them the one
 * string in this API that a human controls. They land in a model's context, so
 * they are treated as untrusted input: control/format characters, newlines and
 * angle brackets are stripped, whitespace collapsed, length capped. A channel
 * renamed "ignore previous instructions" still reaches the model, but it arrives
 * as a single inert label rather than a multi-line instruction block.
 */
// Strip control characters and formatting punctuation, but never the length:
// truncation is a separate decision per field.
function cleanText(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

// Names are labels: guild, channel, tag kind, prize. A 64-character cap keeps a
// single pathological value from eating the payload, and a label cut short is
// still a usable label.
function safeLabel(name) {
  const cleaned = cleanText(name);
  return cleaned === null ? null : cleaned.slice(0, 64).trim() || null;
}

// Notes are prose, and a schedule note ran to exactly 64 characters often
// enough to matter: the payload ended mid-list ("match days 11/07, 11/08,
// 11/14, ") with nothing marking it as short, which reads as a corrupt record
// rather than a shortened one. Long form gets room, and a visible ellipsis.
const NOTE_MAX = 512;
function safeNote(value) {
  const cleaned = cleanText(value);
  if (cleaned === null) return null;
  return cleaned.length > NOTE_MAX ? `${cleaned.slice(0, NOTE_MAX - 1).trimEnd()}…` : cleaned;
}

function channelNames(db, ids) {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.all(
    `SELECT channel_id, name FROM channel_name WHERE channel_id IN (${placeholders})`,
    ...ids,
  );
  return new Map(rows.map((r) => [r.channel_id, safeLabel(r.name)]));
}

/**
 * When measurement actually began, as epoch seconds. backfill.completed is
 * stamped at the end of the first-boot join backfill; boot.first covers a
 * process that died before finishing it.
 */
function collectionStart(db) {
  const stamp = db.getMeta('backfill.completed') ?? db.getMeta('boot.first') ?? null;
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function collectionStartLabel(db) {
  const started = collectionStart(db);
  return started === null ? 'an unknown time' : isoDate(started);
}

/**
 * One sentence for a window that mostly predates the install.
 *
 * Without it, a 30d window two hours after install returns messages: 0 and every
 * other total at (or near) zero, with nothing in the payload distinguishing
 * "quiet server" from "we have two hours of data". The zeros are correct; the
 * silence about them is what produces a confidently wrong answer.
 */
/**
 * '30d' -> '30-day'. The caveat that explains an empty dataset and the one that
 * explains a short window have to name the same window the same way, or the two
 * read as being about different periods.
 */
function spellWindow(label) {
  if (!label || label === 'all') return 'all-time';
  const n = Number.parseInt(label, 10);
  if (!Number.isFinite(n)) return String(label);
  return n === 1 ? '24-hour' : `${n}-day`;
}

function coverageCaveat(db, config, from, ts, { joinsBackfilled = false } = {}) {
  if (!from) return null; // "all" has no start to be short of
  const started = collectionStart(db);
  if (started === null || started <= from) return null;

  const windowDays = (ts - from) / DAY;
  const coveredDays = Math.max(0, (ts - Math.max(from, started)) / DAY);

  // "0.01 days" is accurate and useless; scale the span to something readable.
  const span = (days) => {
    if (days < 1 / 24) return `${Math.max(Math.round(days * 24 * 60), 1)} minutes`;
    if (days < 1) return `${(days * 24).toFixed(1)} hours`;
    return `${days.toFixed(1)} days`;
  };
  const windowText = windowDays < 1 ? `${(windowDays * 24).toFixed(1)} hours` : `${Math.round(windowDays)}-day`;

  return (
    `Collection began ${isoDate(started)}, so only the last ${span(coveredDays)} of this ` +
    `${windowText} window has measured activity (messages, voice, leaves). The counts are ` +
    'small because the history is missing, not because activity fell - check days_with_data ' +
    'before describing a trend.' +
    // Joins are the one measure with history, and saying they are "missing" made
    // a 365-day joins total of 471 look unreliable when it was the best number in
    // the payload.
    (joinsBackfilled
      ? ' Joins are the exception: they are backfilled from each member\'s join date and do ' +
        'cover the whole window, for current members only.'
      : '')
  );
}

function quality(db, config, ts) {
  return {
    generated_at: iso(ts),
    collection_started: db.getMeta('backfill.completed') ?? db.getMeta('boot.first') ?? null,
    backfill_complete: Boolean(db.getMeta('backfill.joinedAt.v1')),
    per_member_counters: config.privacy.perMemberCounters,
    per_channel_metrics: config.privacy.perChannelMetrics,
    retention: {
      hourly_days: config.storage.retentionHourlyDays,
      daily_days: config.storage.retentionDailyDays,
    },
  };
}

const CAVEATS = [
  'Discord exposes no API for Server Insights; every figure here is measured by this bot.',
  'Nothing before the bot was installed exists except joins, which are backfilled from each member join date.',
  'Departed members are invisible, so churn cannot be reconstructed historically - only from install date forward.',
  'unique_authors_sum is a per-channel distinct count summed; a member active in two channels counts twice. It is an upper bound, not a headcount - use unique_authors_exact (day/hour buckets) or totals.unique_posters for a deduplicated figure.',
  'Exact poster counts (unique_authors_exact, avg_daily_posters) begin at first collection; per-channel distinct counts cannot be retroactively deduplicated.',
  'Message content is never read or stored. Only counts are recorded.',
  'Voice is member-seconds in non-AFK channels; a member alone still counts. Muted members count as present unless the collector runs in VOICE_COUNT_MODE=unmuted.',
  'approximate_presence_count is a Discord-side estimate and drifts from the true online figure.',
];

export function meta(db, config, ts = now()) {
  return {
    name: 'discord-metrics-bot',
    version: 1,
    guild: {
      id: db.getMeta('guild.id'),
      name: safeLabel(db.getMeta('guild.name')),
    },
    endpoints: [
      '/v1/summary', '/v1/growth', '/v1/activity', '/v1/voice',
      '/v1/events', '/v1/tags', '/v1/engagement', '/v1/presence', '/v1/structure',
      '/v1/quality',
    ],
    definitions: {
      messages: 'Count of human-authored guild messages, per hour/day bucket.',
      event_status: 'scheduled | active | completed | canceled, decoded from Discord\'s numeric event status.',
      days_with_data: 'Distinct days in the window on which the collector recorded any row (messages, voice or growth). If it is far below the window length, the bot was not running for part of it. Lower than the window length when collection started mid-window or the bot was down; it is coverage, not a count of "active" days.',
      unique_authors_sum: 'Sum of per-channel distinct authors; an upper bound.',
      voice_seconds: 'Member-seconds in non-AFK voice channels, muted members included by default.',
      joins: 'guildMemberAdd events, bots excluded.',
      leaves: 'guildMemberRemove events, bots excluded.',
      net: 'joins - leaves for the same bucket.',
      tenure: 'Share of *current* members who first joined within N days.',
      turnout: 'subscriberCount on a scheduled event at observation time.',
      unique_authors_exact: 'Guild-wide distinct posters for a day or hour bucket, deduplicated across channels.',
      unique_posters: 'Distinct posters over the window, deduplicated across channels. Null unless PER_MEMBER_COUNTERS=hmac and the window fits hourly retention; check unique_posters_basis (exact | partial | unavailable) and unique_posters_since.',
      unique_posters_reason: 'Why unique_posters is unavailable: counters_disabled (PER_MEMBER_COUNTERS is not hmac), beyond_retention (window predates the hourly retention horizon), or no_rows (no per-member rows collected yet, e.g. a fresh install). Null when a figure is present.',
      avg_daily_posters: 'Mean exact daily poster count over days that had activity. Available without per-member rows.',
      concentration: 'How unevenly messaging is distributed across active members.',
      uplift: `A tagged event window expressed as a multiple of the trailing ${config.analytics.eventBaselineDays}-day per-day baseline.`,
    },
    caveats: CAVEATS,
    quality: quality(db, config, ts),
  };
}

export function summary(db, config, { window, ts = now() }) {
  const from = cutoff(window, ts);
  const coverage = coverageCaveat(db, config, from, ts, { joinsBackfilled: true });

  const snap = db.get('SELECT * FROM snapshot ORDER BY ts DESC LIMIT 1');
  const msg = db.get(
    `SELECT COALESCE(SUM(messages),0) AS messages FROM message_day WHERE day_ts >= ?`,
    from,
  );
  // "Days with data" has to mean days the collector observed anything, not just
  // days with messages: on a voice-heavy or freshly installed server the two are
  // wildly different, and a 0 next to a real voice total reads as a broken field.
  const coveredDays = db.get(
    `SELECT COUNT(*) AS n FROM (
       SELECT day_ts FROM message_day WHERE day_ts >= ?
       UNION SELECT day_ts FROM voice_day WHERE day_ts >= ?
       UNION SELECT day_ts FROM growth_day WHERE day_ts >= ?)`,
    from,
    from,
    from,
  );
  const voice = db.get(
    `SELECT COALESCE(SUM(seconds),0) AS seconds FROM voice_day WHERE day_ts >= ?`,
    from,
  );
  const growth = joinsForWindow(db, from, ts);
  const topChannel = db.get(
    `SELECT channel_id, SUM(messages) AS messages
       FROM message_day WHERE day_ts >= ?
      GROUP BY channel_id ORDER BY messages DESC LIMIT 1`,
    from,
  );

  const names = topChannel ? channelNames(db, [topChannel.channel_id]) : new Map();

  // Two different questions, answered without conflating them:
  //   unique_posters     - distinct people over the whole window. Needs one row
  //                        per member, so it is exact only in hmac mode and only
  //                        while hourly rows still exist.
  //   avg_daily_posters  - mean of the exact daily count. Works in any privacy
  //                        mode because only a scalar was stored.
  // Summing daily distincts would NOT give a window distinct count: someone
  // active on ten days is one person, not ten.
  const hourlyCutoff = ts - config.storage.retentionHourlyDays * DAY;
  const hmac = config.privacy.perMemberCounters === 'hmac';
  const withinHourly = window.label !== 'all' && from >= hourlyCutoff;

  // member_hour begins when collection began — or when PER_MEMBER_COUNTERS was
  // switched to hmac, which an operator can do at any time. A window reaching
  // further back than the rows do would count only the recent tail and still
  // call itself exact, and nothing downstream could tell. Count from where the
  // rows actually start and label the result accordingly.
  let uniquePosters = null;
  let uniquePostersSince = null;
  let uniquePostersBasis = 'unavailable';
  // Why it is unavailable matters: "counters turned off", "window reaches past
  // hourly retention" and "nothing collected yet" are three different things to
  // tell a user, and guessing between them produced a false explanation.
  let uniquePostersReason = !hmac
    ? 'counters_disabled'
    : !withinHourly
      ? 'beyond_retention'
      : 'no_rows';
  if (hmac && withinHourly) {
    const firstMemberHour = db.get('SELECT MIN(hour_ts) AS v FROM member_hour')?.v ?? null;
    if (firstMemberHour !== null) {
      const coveredFrom = Math.max(from, firstMemberHour);
      uniquePosters = db.get(
        `SELECT COUNT(DISTINCT user_hmac) AS n
           FROM member_hour WHERE hour_ts >= ? AND messages > 0`,
        coveredFrom,
      )?.n ?? 0;
      uniquePostersSince = iso(coveredFrom);
      uniquePostersBasis = coveredFrom > from ? 'partial' : 'exact';
      uniquePostersReason = null;
    }
  }

  const posterRoll = db.get(
    `SELECT COALESCE(SUM(posters),0) AS total, COUNT(*) AS days
       FROM poster_day WHERE day_ts >= ?`,
    from,
  );
  const avgDailyPosters =
    posterRoll?.days > 0 ? Number((posterRoll.total / posterRoll.days).toFixed(1)) : null;

  return {
    window: window.label,
    guild: {
      name: safeLabel(db.getMeta('guild.name')),
      members: snap?.members ?? null,
      online: snap?.online ?? null,
      boosts: snap?.boosts ?? null,
      tier: snap?.tier ?? null,
      channels: snap?.channels ?? null,
      roles: snap?.roles ?? null,
      snapshot_at: snap ? iso(snap.ts) : null,
    },
    totals: {
      messages: msg?.messages ?? 0,
      // Named for what it is. As "active_days" it sat next to "messages" and read
      // as engagement ("only 90 active days out of 365"), when it actually means
      // 90 days of coverage since install.
      days_with_data: coveredDays?.n ?? 0,
      voice_seconds: voice?.seconds ?? 0,
      joins: growth.joins,
      leaves: growth.leaves,
      net: growth.joins - growth.leaves,
      backfilled_joins: growth.backfilled_joins,
      unique_posters: uniquePosters,
      unique_posters_since: uniquePostersSince,
      avg_daily_posters: avgDailyPosters,
      unique_posters_basis: uniquePostersBasis,
      unique_posters_reason: uniquePostersReason,
    },
    busiest_channel: topChannel
      ? {
          id: topChannel.channel_id,
          name: names.get(topChannel.channel_id) ?? null,
          messages: topChannel.messages,
        }
      : null,
    caveats: [
      ...(coverage ? [coverage] : []),
      ...(uniquePostersBasis === 'partial'
        ? [
            `unique_posters covers only from ${uniquePostersSince}: per-member rows do not ` +
              `reach back to the start of the ${window.label} window, so it is a floor. ` +
              'avg_daily_posters spans the full window and is the better figure here.',
          ]
        : []),
      // A null unique_posters next to a real avg_daily_posters reads as broken
      // data unless it is explained: the per-day figure works without per-member
      // rows, and the two are not interchangeable.
      ...(uniquePostersBasis === 'unavailable'
        ? [
            {
              counters_disabled:
                'unique_posters needs PER_MEMBER_COUNTERS=hmac, which is off here. ' +
                'avg_daily_posters is available without it; it is a mean per day, not a distinct ' +
                'count, so do not multiply it to estimate a window total.',
              beyond_retention:
                `unique_posters needs per-member rows, and this ${window.label} window reaches ` +
                `past hourly retention (${config.storage.retentionHourlyDays} days). ` +
                'avg_daily_posters is available for the full window; it is a mean per day, not a ' +
                'distinct count.',
              no_rows:
                `No message has been counted yet, so there is nothing to deduplicate: collection ` +
                `began ${collectionStartLabel(db)}, inside this ${spellWindow(window.label)} window. This is an ` +
                'empty dataset, not a server with no posters.',
            }[uniquePostersReason],
          ]
        : []),
      ...CAVEATS.slice(0, 4),
    ],
    quality: quality(db, config, ts),
  };
}

/**
 * Joins and leaves over a window, from both sources.
 *
 * growth_day only has rows since install, while growth_backfill carries each
 * current member's join date for the whole history. summary() read only the
 * first table, so it answered "0 joined in the last 30 days" to a question the
 * growth endpoint answered with 54. Two endpoints contradicting each other is
 * worse than either being wrong, because nothing in the payload reveals it.
 */
function joinsForWindow(db, from, ts) {
  const measured = db.get(
    `SELECT COALESCE(SUM(joins),0) AS joins, COALESCE(SUM(leaves),0) AS leaves
       FROM growth_day WHERE day_ts >= ?`,
    from,
  );
  const earliestLive =
    db.get('SELECT MIN(day_ts) AS v FROM growth_day WHERE day_ts >= ?', from)?.v ?? null;
  const backfilled = db.get(
    `SELECT COALESCE(SUM(joins),0) AS joins
       FROM growth_backfill WHERE day_ts >= ? AND day_ts < ?`,
    from,
    earliestLive ?? ts,
  );

  const backfilledJoins = backfilled?.joins ?? 0;
  const measuredJoins = measured?.joins ?? 0;
  return {
    joins: measuredJoins + backfilledJoins,
    leaves: measured?.leaves ?? 0,
    backfilled_joins: backfilledJoins,
    measured_joins: measuredJoins,
  };
}

export function growth(db, config, { window, bucket, ts = now() }) {
  const from = cutoff(window, ts);
  const coverage = coverageCaveat(db, config, from, ts, { joinsBackfilled: true });
  const { table } = sourceFor({ window, bucket, retentionHourlyDays: config.storage.retentionHourlyDays });

  const key = table === 'hour' ? 'hour_ts' : 'day_ts';
  const rows = db.all(
    `SELECT ${key} AS ts, joins, leaves, members
       FROM growth_${table}
      WHERE ${key} >= ?
      ORDER BY ${key} ASC`,
    from,
  );

  // Days that predate the live collector: fill from the joined_at backfill so
  // the curve reaches back to server founding instead of starting at install.
  const earliestLive = rows.length ? rows[0].ts : ts;
  const historical =
    from < earliestLive
      ? db.all(
          `SELECT day_ts AS ts, joins FROM growth_backfill
            WHERE day_ts >= ? AND day_ts < ?
            ORDER BY day_ts ASC`,
          from,
          earliestLive,
        )
      : [];

  const merged = [
    ...historical.map((r) => ({ ts: r.ts, joins: r.joins, leaves: 0, members: null, source: 'backfill' })),
    ...rows.map((r) => ({ ...r, source: 'measured' })),
  ].sort((a, b) => a.ts - b.ts);

  const series = rollup(merged, bucket).map((r) => {
    const point = {
      bucket: bucketLabel(r.ts, bucket),
      joins: r.joins ?? 0,
      leaves: r.leaves ?? 0,
      net: (r.joins ?? 0) - (r.leaves ?? 0),
    };
    // members is an absolute headcount, and only days the collector actually
    // observed have one. Emitting null for every backfilled bucket padded a
    // 90-day series with 67 fields that say nothing; omit the key instead.
    if (r.members !== null && r.members !== undefined) point.members = r.members;
    return point;
  });


  // Without these, "how many joined in 90 days" means summing 90 entries in a
  // model's head — the exact operation models get wrong. Sum here instead, and
  // keep the backfilled portion visible so the two sources are never conflated.
  const sumJoins = merged.reduce((acc, r) => acc + (r.joins ?? 0), 0);
  const sumLeaves = merged.reduce((acc, r) => acc + (r.leaves ?? 0), 0);
  const backfilledJoins = historical.reduce((acc, r) => acc + (r.joins ?? 0), 0);

  const currentMembers = db.get('SELECT members FROM snapshot ORDER BY ts DESC LIMIT 1')?.members
    ?? db.getMeta('backfill.members');

  const tenure = tenureBreakdown(db, currentMembers, ts);

  // Tenure shares divide by the live headcount now, so the old "frozen denominator"
  // warning is gone. What is still true: the numerator counts join *events*, so a
  // member who joined and later left is counted too, and on a long window with churn
  // the numerator can pass the current headcount.
  const inflated = tenure
    ? Object.entries(tenure)
        .filter(([k, v]) => k.startsWith('last_') && v?.share > 1)
        .map(([k]) => k.replace('last_', ''))
    : [];
  const tenureCaveat = inflated.length
    ? `Tenure shares exceed 1.0 on ${inflated.join(', ')}: the numerator counts join events, ` +
      `including members who later left, while the denominator is today's headcount ` +
      `(${tenure.total_members}). Read those as "joins relative to current size", not as a ` +
      `proportion of the people here now.`
    : null;

  return {
    window: window.label,
    bucket,
    series,
    series_meta: seriesMeta({ window, bucket, from, ts, returned: series.length }),
    totals: {
      joins: sumJoins,
      leaves: sumLeaves,
      net: sumJoins - sumLeaves,
      backfilled_joins: backfilledJoins,
      members_now: currentMembers ?? null,
    },
    tenure,
    caveats: [
      ...(coverage ? [coverage] : []),
      'Leaves are zero for buckets that predate installation; historical joins come from member join dates.',
      'totals.joins mixes two sources: backfilled_joins are current members only (departed members are invisible), while measured joins are join events and include people who later left.',
      'tenure counts current members only and therefore excludes everyone who already left.',
      ...(tenureCaveat ? [tenureCaveat] : []),
    ],
    quality: quality(db, config, ts),
  };
}

function tenureBreakdown(db, currentMembers, ts) {
  // The denominator is TODAY's headcount, because the metric is defined as the
  // share of *current* members who joined within N days. It used to divide by
  // backfill.members — the headcount captured once at install — which made every
  // share drift upward as the server grew and let shares exceed 1.0 on long
  // windows. members_at_install keeps that figure available for context.
  const installMembers = Number(db.getMeta('backfill.members') ?? 0) || null;
  const total = Number(currentMembers ?? 0) || installMembers;
  if (!total) return null;

  // growth_backfill is a snapshot taken once, from the joinedAt of the members
  // that existed then. Anyone who joined afterwards is absent from it — so
  // counting tenure from that table alone reports "0 new members in the last 7
  // days" on a server that gained forty, while the summary simultaneously says
  // joins went up. Split at the install day and add the measured joins after it.
  const installDay = db.get('SELECT MIN(day_ts) AS v FROM growth_day')?.v ?? null;
  const joinsSince = db.raw.prepare(
    installDay === null
      ? 'SELECT COALESCE(SUM(joins),0) AS n FROM growth_backfill WHERE day_ts >= ?'
      : `SELECT COALESCE(SUM(joins),0) AS n FROM growth_backfill WHERE day_ts >= ? AND day_ts < ?`,
  );
  const measuredSince = db.raw.prepare(
    'SELECT COALESCE(SUM(joins),0) AS n FROM growth_day WHERE day_ts >= ?',
  );

  const buckets = [
    ['last_7d', 7],
    ['last_30d', 30],
    ['last_90d', 90],
    ['last_365d', 365],
  ];
  const out = {};
  for (const [label, days] of buckets) {
    const since = ts - days * DAY;
    const reclaimed = installDay === null ? joinsSince.get(since).n : joinsSince.get(since, installDay).n;
    const measured = installDay === null ? 0 : measuredSince.get(Math.max(since, installDay)).n;
    const n = reclaimed + measured;
    out[label] = {
      members: n,
      share: Number((n / total).toFixed(3)),
      from_backfill: reclaimed,
      from_measured: measured,
    };
  }
  out.total_members = total;
  // Kept so the install-day headcount is still answerable, now that it is no
  // longer the denominator. null if the meta key predates the backfill.
  out.members_at_install = installMembers;
  return out;
}

export function activity(db, config, { window, bucket, top, ts = now() }) {
  const from = cutoff(window, ts);
  const coverage = coverageCaveat(db, config, from, ts);
  const { table } = sourceFor({ window, bucket, retentionHourlyDays: config.storage.retentionHourlyDays });
  const key = table === 'hour' ? 'hour_ts' : 'day_ts';

  const rows = db.all(
    `SELECT ${key} AS ts,
            SUM(messages) AS messages,
            SUM(unique_authors) AS unique_authors_sum
       FROM message_${table}
      WHERE ${key} >= ?
      GROUP BY ${key}
      ORDER BY ${key} ASC`,
    from,
  );

  const topRows = config.privacy.perChannelMetrics
    ? db.all(
        `SELECT channel_id, SUM(messages) AS messages
           FROM message_${table}
          WHERE ${key} >= ?
          GROUP BY channel_id
          ORDER BY messages DESC
          LIMIT ?`,
        from,
        top,
      )
    : [];

  const names = channelNames(db, topRows.map((r) => r.channel_id));

  // Exact posters are a distinct-count, so they can only be reported at the
  // granularity they were measured at. Rolling a week up by summing daily
  // distincts would count one member seven times, so coarser buckets get null
  // rather than a confidently wrong number.
  const posterKey = table === 'hour' ? 'hour_ts' : 'day_ts';
  const posterByTs = new Map(
    db
      .all(`SELECT ${posterKey} AS ts, posters FROM poster_${table} WHERE ${posterKey} >= ?`, from)
      .map((r) => [r.ts, r.posters]),
  );
  const exactAt = table === 'hour' || bucket === 'day';

  return {
    window: window.label,
    bucket,
    series: rollup(rows, bucket).map((r) => ({
      bucket: bucketLabel(r.ts, bucket),
      messages: r.messages ?? 0,
      unique_authors_sum: r.unique_authors_sum ?? 0,
      unique_authors_exact: exactAt ? posterByTs.get(r.ts) ?? null : null,
    })),
    series_meta: seriesMeta({
      window,
      bucket,
      from,
      ts,
      returned: rollup(rows, bucket).length,
    }),
    top_channels: topRows.map((r) => ({
      id: r.channel_id,
      name: names.get(r.channel_id) ?? null,
      messages: r.messages,
    })),
    caveats: [
      ...(coverage ? [coverage] : []),
      'unique_authors_sum double-counts a member who posts in more than one channel.',
      'unique_authors_exact is deduplicated guild-wide and is the figure to quote. It is null for week/month buckets because distinct counts do not sum across days.',
      'Bots and webhook messages are excluded; system messages are excluded.',
    ],
    quality: quality(db, config, ts),
  };
}

export function voice(db, config, { window, bucket, top, ts = now() }) {
  const from = cutoff(window, ts);
  const coverage = coverageCaveat(db, config, from, ts);
  const { table } = sourceFor({ window, bucket, retentionHourlyDays: config.storage.retentionHourlyDays });
  const key = table === 'hour' ? 'hour_ts' : 'day_ts';

  const rows = db.all(
    `SELECT ${key} AS ts,
            SUM(seconds) AS seconds,
            SUM(unique_users) AS unique_users_sum
       FROM voice_${table}
      WHERE ${key} >= ?
      GROUP BY ${key}
      ORDER BY ${key} ASC`,
    from,
  );

  const topRows = config.privacy.perChannelMetrics
    ? db.all(
        `SELECT channel_id, SUM(seconds) AS seconds
           FROM voice_${table}
          WHERE ${key} >= ?
          GROUP BY channel_id
          ORDER BY seconds DESC
          LIMIT ?`,
        from,
        top,
      )
    : [];

  const names = channelNames(db, topRows.map((r) => r.channel_id));

  // Same reasoning as growth.totals: a window total is what people ask for, and
  // summing a series by hand is the step a model gets wrong.
  const totalSeconds = rows.reduce((acc, r) => acc + (r.seconds ?? 0), 0);
  const activeBuckets = rows.filter((r) => (r.seconds ?? 0) > 0).length;

  // Which rule was in force says what a zero means: under `present` it is "nobody was
  // in a channel"; under `unmuted` it can also be "everybody was muted". That is not
  // recoverable from the numbers, and it was only discoverable from a debug log on the
  // host — which is why a metric reading a flat zero looked like a broken collector.
  const countMode = config?.privacy?.voiceCountMode ?? 'present';

  return {
    window: window.label,
    bucket,
    voice_count_mode: countMode,
    series: rollup(rows, bucket).map((r) => ({
      bucket: bucketLabel(r.ts, bucket),
      voice_seconds: r.seconds ?? 0,
      voice_hours: Number(((r.seconds ?? 0) / 3600).toFixed(2)),
      unique_users_sum: r.unique_users_sum ?? 0,
    })),
    totals: {
      voice_seconds: totalSeconds,
      voice_hours: Number((totalSeconds / 3600).toFixed(2)),
      active_buckets: activeBuckets,
      buckets: rows.length,
    },
    series_meta: seriesMeta({
      window,
      bucket,
      from,
      ts,
      returned: rollup(rows, bucket).length,
    }),
    top_channels: topRows.map((r) => ({
      id: r.channel_id,
      name: names.get(r.channel_id) ?? null,
      voice_hours: Number((r.seconds / 3600).toFixed(2)),
    })),
    caveats: [
      ...(coverage ? [coverage] : []),
      'Member-seconds: two people for one hour equals one person for two hours.',
      countMode === 'unmuted'
        ? 'Counted in unmuted mode: a member had to be unmuted and undeafened to accrue time, so a muted lobby reads as zero.'
        : 'Counted in present mode: a muted member sitting in a channel still accrues time, because a phone-based group mutes in a lobby and keeps playing.',
      // The old wording claimed restarts discard in-flight sessions. That stopped
      // being true: maintenance.stop() flushes (and voice.flush ticks open sessions
      // forward), and boot now adopts whoever is already in a channel. A caveat
      // that describes the previous behaviour is worse than none, because it reads
      // as an explanation for a gap that is no longer there.
      'In-flight sessions are flushed on graceful shutdown and re-adopted at boot, so a normal redeploy keeps voice time. Two gaps remain: a hard kill (SIGKILL) loses everything since the last flush, and time a member spent in a channel before the bot started is unknowable — their session begins at boot.',
    ],
    quality: quality(db, config, ts),
  };
}

/**
 * Point-in-time view of the newest snapshot. Deliberately no history: this is the
 * "who is around right now" question, not a trend.
 */
export function presence(db, config, { ts = now() } = {}) {
  const snap = db.get('SELECT * FROM snapshot ORDER BY ts DESC LIMIT 1');
  const age = snap ? ts - snap.ts : null;
  const staleAfter = config.analytics.presenceStaleSeconds;

  return {
    snapshot_at: snap ? iso(snap.ts) : null,
    age_seconds: age,
    stale: age === null || age > staleAfter,
    members: snap?.members ?? null,
    bots: snap?.bots ?? null,
    humans: snap ? snap.members - snap.bots : null,
    online: snap?.online ?? null,
    online_ratio:
      snap && snap.members > 0 ? Number((snap.online / snap.members).toFixed(4)) : null,
    boosts: snap?.boosts ?? null,
    tier: snap?.tier ?? null,
    caveats: [
      'online is a presence-cache sample, not an exact figure; it lags by up to one poll interval.',
      'A member invisible or offline on another device is not counted, so online undercounts at low activity.',
    ],
  };
}

/** Coverage and known gaps. Call before making a strong claim about a trend. */
export function qualityReport(db, config, { ts = now(), voiceStats = null } = {}) {
  // DISTINCT matters: message_day and voice_day are keyed (day_ts, channel_id),
  // so COUNT(*) returns channel rows, not days. Two channels active on the
  // install day reported partial_days.messages = 2 - a day counted twice.
  const partial = db.get(
    `SELECT
       (SELECT COUNT(DISTINCT day_ts) FROM message_day WHERE partial = 1) AS message_days,
       (SELECT COUNT(DISTINCT day_ts) FROM voice_day   WHERE partial = 1) AS voice_days,
       (SELECT COUNT(DISTINCT day_ts) FROM growth_day  WHERE partial = 1) AS growth_days`,
  );

  // The first day the collector saw from start to finish. MIN(day_ts) was simply
  // the first day with rows, which is the install day - so the payload claimed a
  // full day of coverage on the same day it listed as partial. A day qualifies
  // only if collection had already begun when it started, it has ended, and no
  // table marks it partial.
  const installTs = collectionStart(db);
  const installDay = installTs === null ? null : dayOf(installTs);
  const firstPossibleFull = installDay === null ? -1 : installDay + (installTs === installDay ? 0 : DAY);
  const partialDays = `SELECT day_ts FROM message_day WHERE partial = 1
                       UNION SELECT day_ts FROM voice_day WHERE partial = 1
                       UNION SELECT day_ts FROM growth_day WHERE partial = 1`;
  const first = db.get(
    `SELECT MIN(day_ts) AS ts FROM (
       SELECT day_ts FROM message_day WHERE partial = 0
       UNION SELECT day_ts FROM voice_day WHERE partial = 0
       UNION SELECT day_ts FROM growth_day WHERE partial = 0
     )
     WHERE day_ts >= ? AND day_ts < ? AND day_ts NOT IN (${partialDays})`,
    firstPossibleFull,
    dayOf(ts),
  );

  // Counts alone answer "should I distrust this?" but not "which day was it?",
  // which is the actual follow-up — a dip is explainable if it lines up with a
  // restart. Cap the list so a long outage streak cannot flood the payload.
  const PARTIAL_LIST_LIMIT = 5;
  const partialDates = { messages: [], voice: [], growth: [] };
  // UNION (not UNION ALL) collapses the per-channel rows of a single day, which
  // otherwise ate the per-table cap with the same date repeated.
  for (const row of db.all(
    `SELECT 'messages' AS src, day_ts FROM message_day WHERE partial = 1
     UNION SELECT 'voice', day_ts FROM voice_day WHERE partial = 1
     UNION SELECT 'growth', day_ts FROM growth_day WHERE partial = 1
     ORDER BY day_ts DESC
     LIMIT ?`,
    3 * PARTIAL_LIST_LIMIT,
  )) {
    const bucket = partialDates[row.src];
    if (bucket.length < PARTIAL_LIST_LIMIT) bucket.push(isoDate(row.day_ts));
  }

  // The denominator behind every activity figure. Both false alarms this server
  // has had ("why are there no messages", "why is voice always zero") were really
  // the question "can the bot even see the channels this happens in", which was
  // unanswerable until the structure tables existed.
  const structureTs = Number(db.getMeta('structure.refreshed_ts') ?? 0) || null;
  const channelCoverage = structureTs
    ? db.get(
        `SELECT
           COUNT(*) FILTER (WHERE type <> 'category' AND deleted_ts IS NULL) AS total,
           COUNT(*) FILTER (WHERE type <> 'category' AND deleted_ts IS NULL AND bot_can_view = 1) AS visible,
           COUNT(*) FILTER (WHERE type <> 'category' AND deleted_ts IS NULL AND bot_can_view = 0) AS invisible
         FROM channel_meta`,
      )
    : null;

  return {
    ...quality(db, config, ts),
    coverage: channelCoverage
      ? {
          structure_observed_at: iso(structureTs),
          channels_total: channelCoverage.total ?? 0,
          // Same names as structure().coverage: the model reads both, and two
          // spellings of one number invites quoting the wrong one.
          visible_to_bot: channelCoverage.visible ?? 0,
          invisible_to_bot: channelCoverage.invisible ?? 0,
          note:
            channelCoverage.invisible > 0
              ? `${channelCoverage.invisible} of ${channelCoverage.total} channels are invisible to the ` +
                'bot, so their messages and voice are not counted anywhere. Activity totals are a ' +
                'lower bound by that much. Use get_server_structure for the list.'
              : 'The bot can see every channel, so activity totals cover the whole server.',
        }
      : {
          available: false,
          reason:
            'Channel visibility has not been collected yet. Once the collector writes it, this ' +
            'block reports how many channels the bot can actually see.',
        },
    first_full_day: first?.ts ? iso(first.ts) : null,
    partial_days: {
      messages: partial?.message_days ?? 0,
      voice: partial?.voice_days ?? 0,
      growth: partial?.growth_days ?? 0,
      recent: partialDates,
      note: 'A partial day was observed for only part of the day (restart or install). Its totals are a lower bound. recent lists the most recent such days (up to 5 per table).',
    },
    boots: Number(db.getMeta('boot.count') ?? 0),
    last_boot: db.getMeta('boot.last') ?? null,
    // Live, in-process collector state, so a voice_seconds that sits still can be
    // diagnosed from outside: 0 open sessions means nothing is being measured right
    // now (nobody in a channel, or a session that was never re-adopted after a
    // restart), while sessions_started > 0 with 0 active means sessions are closing.
    // Stored data cannot answer this — only the running process knows.
    voice_collector: voiceStats
      ? {
          count_mode: voiceStats.countMode ?? config?.privacy?.voiceCountMode ?? 'present',
          active_sessions: voiceStats.activeSessions ?? null,
          sessions_started: voiceStats.started ?? null,
          pending_hours: voiceStats.pendingHours ?? 0,
          pending_days: voiceStats.pendingDays ?? 0,
          last_seed_states: voiceStats.lastSeedStates ?? null,
          last_seed_unknown: voiceStats.lastSeedUnknown ?? null,
          note:
            'Live collector state, not stored history. active_sessions = 0 while members are '
            + 'in voice means no session is open and nothing is accruing right now. '
            + 'last_seed_unknown > 0 means boot re-adoption could not resolve that many '
            + 'voice states to members, so those members were skipped.',
        }
      : {
          available: false,
          reason: 'The API was started without collectors, so live voice state is unknown.',
        },
  };
}

/**
 * Discord permission bits worth naming in a payload. Anything not listed stays
 * inside the bitfield and is simply not reported; a role is summarised by the
 * handful of bits that change what a server can do to itself.
 */
const PERMISSION_FLAGS = [
  ['administrator', 3n],
  ['manage_guild', 5n],
  ['manage_roles', 28n],
  ['manage_channels', 4n],
  ['manage_messages', 13n],
  ['manage_webhooks', 29n],
  ['kick_members', 1n],
  ['ban_members', 2n],
  ['mention_everyone', 17n],
  ['view_audit_log', 7n],
  ['moderate_members', 40n],
];
// The three that amount to "can reshape the server".
const ELEVATED = new Set(['administrator', 'manage_guild', 'manage_roles']);

/**
 * Returns the audited flags that are set, `[]` when none of them are, and `null`
 * when the stored decimal cannot be parsed. The three are different answers:
 * `[]` is "nothing notable" (a role with only send-messages and view-channel
 * lands here), and collapsing it into the unparseable case would let a broken
 * bitfield read as a safely boring role.
 */
function permissionFlags(decimal) {
  if (decimal === null || decimal === undefined) return null;
  let bits;
  try {
    bits = BigInt(String(decimal));
  } catch {
    return null;
  }
  return PERMISSION_FLAGS.filter(([, bit]) => (bits & (1n << bit)) !== 0n).map(([name]) => name);
}

function hexColor(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value === 0) return null; // 0 is Discord's "no colour"
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * Server configuration: channels, roles, settings, and how much of it the bot can
 * actually see.
 *
 * This is the half of the picture the activity endpoints cannot supply. "76% of
 * messages are in game-chat" means something very different when 44 of 131
 * channels are invisible to the bot, and a channel with no traffic is a pruning
 * candidate or a deliberate lockdown depending on its overwrites.
 *
 * detail=summary (default) returns counts, the coverage split, the permission
 * audit, per-category rollups and the notable channels. detail=full adds every
 * channel and every role, which is roughly 10x the payload.
 */
const DEFAULT_WINDOW = { label: '30d', seconds: 30 * DAY, all: false };

// Long enough to be actionable, short enough that the payload stays readable.
// The totals travel alongside so a truncated list can never be mistaken for
// the whole set.
const INVISIBLE_LIST_MAX = 50;
const NO_TRAFFIC_LIST_MAX = 25;

export function structure(
  db,
  config,
  { window = DEFAULT_WINDOW, detail = 'summary', ts = now() } = {},
) {
  const observedTs = Number(db.getMeta('structure.refreshed_ts') ?? 0) || null;
  const channels = db.all('SELECT * FROM channel_meta WHERE deleted_ts IS NULL');
  const roles = db.all('SELECT * FROM role_meta WHERE deleted_ts IS NULL');
  const full = detail === 'full';

  if (channels.length === 0 && roles.length === 0) {
    return {
      available: false,
      reason:
        'No server structure has been collected yet. The collector writes it on startup; ' +
        'this endpoint returns data once the bot has completed a ready cycle on a build that ' +
        'includes structure collection.',
      running_build: db.getMeta('boot.count') ? Number(db.getMeta('boot.count')) : null,
    };
  }

  const from = cutoff(window, ts);
  const windowStart = dayOf(from);

  const traffic = new Map(
    db
      .all(
        `SELECT channel_id, SUM(messages) AS messages, COUNT(DISTINCT day_ts) AS active_days
           FROM message_day WHERE day_ts >= ? GROUP BY channel_id`,
        windowStart,
      )
      .map((r) => [r.channel_id, r]),
  );
  const voiceUse = new Map(
    db
      .all(
        `SELECT channel_id, SUM(seconds) AS seconds FROM voice_day
          WHERE day_ts >= ? GROUP BY channel_id`,
        windowStart,
      )
      .map((r) => [r.channel_id, r]),
  );

  // Categories first, so a channel can be placed under its parent by name.
  const categories = new Map();
  for (const ch of channels) {
    if (ch.type === 'category') {
      // channel_id is kept for the child lookup below and stripped from the
      // payload: summaryCategories projects explicit fields, never the object.
      categories.set(ch.channel_id, {
        channel_id: ch.channel_id,
        name: ch.name,
        position: ch.position ?? 0,
        channels: [],
      });
    }
  }

  const channelNames = new Map(channels.map((ch) => [ch.channel_id, ch.name]));

  const annotated = channels
    .filter((ch) => ch.type !== 'category')
    .map((ch) => {
      const seen = ch.bot_can_view === 1 ? true : ch.bot_can_view === 0 ? false : null;
      const measured = seen === true || (traffic.get(ch.channel_id)?.messages ?? 0) > 0;
      return {
      name: ch.name,
      type: ch.type,
      position: ch.position ?? 0,
      // 0 is a real answer here (no slowmode); null is reserved for a value we
      // never captured, so `|| null` was turning every ordinary channel into
      // an unknown one.
      slowmode_seconds: ch.slowmode ?? null,
      nsfw: Boolean(ch.nsfw),
      overwrites: ch.overwrite_count ?? 0,
      // Strictly 0/1/null. Anything else is a row we do not understand, and
      // guessing "truthy means visible" would quietly inflate the coverage
      // denominator — the SQL block in qualityReport counts only bot_can_view = 1,
      // so a loose reading here made the two endpoints disagree.
      visible_to_bot: seen,
      // A channel the bot cannot read has no message figure: 0 would claim it was
      // watched and found silent, which is the exact confusion this endpoint exists
      // to prevent. Traffic that exists anyway (a stale visibility flag) is still
      // reported, because that is evidence the channel is being read.
      messages: measured ? (traffic.get(ch.channel_id)?.messages ?? 0) : null,
      active_days: measured ? (traffic.get(ch.channel_id)?.active_days ?? 0) : null,
      voice_minutes:
        ch.type === 'voice' || ch.type === 'stage'
          ? Math.round(((voiceUse.get(ch.channel_id)?.seconds ?? 0) / 60) * 10) / 10
          : null,
      parent: ch.parent_id ? (categories.get(ch.parent_id)?.name ?? null) : null,
      // A thread hangs off a channel, not a category, so `parent` is null for it
      // while parent_id is set. Naming that channel keeps the two fields from
      // looking like they contradict each other.
      parent_channel: ch.parent_id && !categories.has(ch.parent_id)
        ? (channelNames.get(ch.parent_id) ?? null)
        : null,
      parent_id: ch.parent_id ?? null,
      };
    })
    .sort((a, b) => b.position - a.position);

  // Channels can share a name: this server has two `staff-chat` (text and voice)
  // and two `suggestions-and-questions` (text and forum). Everything below
  // identifies channels by name, so a duplicate entry is unactionable — "grant
  // View Channel on suggestions-and-questions" is a coin flip, and the operator
  // fixes the wrong one. Disambiguate only where a name actually repeats, so the
  // common case stays the bare name.
  const nameTally = new Map();
  for (const c of annotated) nameTally.set(c.name, (nameTally.get(c.name) ?? 0) + 1);

  const labelOf = (c) => {
    if ((nameTally.get(c.name) ?? 0) < 2) return c.name;
    const where = [c.type, c.parent].filter(Boolean).join(', ');
    return where ? `${c.name} (${where})` : c.name;
  };

  // Even with type and category two entries could still collide (a name reused
  // inside one category at the same type), so the last resort is an ordinal.
  const labelList = (list) => {
    const used = new Map();
    return list.map((c) => {
      const base = labelOf(c);
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      return n === 1 ? base : `${base} #${n}`;
    });
  };

  const byType = {};
  for (const ch of annotated) byType[ch.type] = (byType[ch.type] ?? 0) + 1;

  const visible = annotated.filter((c) => c.visible_to_bot === true);
  // Ordered so that a capped list drops the least informative names. Traffic first
  // (those are already being measured, so the flag is the thing to fix), then
  // channels in categories that are mostly visible — a grant there is one click and
  // obviously intended. A category nobody can see at all (Archive) sinks to the
  // bottom, because 46 names of dead channels were crowding out the five arcade
  // channels the operator was actually trying to fix.
  const shareByParent = new Map();
  for (const c of annotated) {
    if (!c.parent_id) continue;
    const s = shareByParent.get(c.parent_id) ?? { seen: 0, total: 0 };
    s.total += 1;
    if (c.visible_to_bot === true) s.seen += 1;
    shareByParent.set(c.parent_id, s);
  }
  // null, not 0, when the parent is unknown — an uncategorised channel and a
  // channel in a wholly-invisible category are both "share 0" numerically, but
  // they are not equally actionable, and conflating them sorted the uncategorised
  // one into the Archive tail of a capped list (live: game-codes came last).
  const visibleShare = (c) => {
    const s = c.parent_id ? shareByParent.get(c.parent_id) : null;
    return s && s.total ? s.seen / s.total : null;
  };
  const grantBucket = (c) => {
    const s = visibleShare(c);
    if (s === null) return 1; // parent unknown: fixable, but no signal to rank by
    if (s === 0) return 2; // wholly invisible category (Archive): leave it for last
    return 0; // partly visible category: the cheapest grant to act on
  };
  const invisible = annotated
    .filter((c) => c.visible_to_bot === false)
    .sort((a, b) =>
      (b.messages ?? 0) - (a.messages ?? 0) ||
      grantBucket(a) - grantBucket(b) ||
      (visibleShare(b) ?? 0) - (visibleShare(a) ?? 0) ||
      b.position - a.position);
  const unknownVisibility = annotated.filter((c) => c.visible_to_bot === null);

  // A channel is "used" if anything happened in it. Splitting the zero-traffic
  // set by visibility is the whole point: invisible is a measurement gap, visible
  // and empty is a decision to make.
  const talkable = visible.filter((c) => ['text', 'announcement', 'forum', 'thread', 'media'].includes(c.type));
  const unusedVisible = talkable.filter((c) => c.messages === 0);

  // A channel flagged invisible that nonetheless produced messages (or voice) in
  // this window contradicts itself: the collector cannot read a channel it
  // cannot see, so one of the two facts is wrong. Usually the permission
  // changed mid-window; occasionally the flag itself is bad. Reporting these as
  // an ordinary silent gap would tell the operator to go grant access that they
  // demonstrably already have — and would inflate the gap estimate with channels
  // that are in fact being measured.
  const contradictions = annotated.filter(
    (c) => c.visible_to_bot !== true && (c.messages > 0 || (c.voice_minutes ?? 0) > 0),
  );

  const voiceChannels = visible.filter((c) => c.type === 'voice' || c.type === 'stage');

  // Lists that name channels are built once, with labels aligned by index, rather
  // than relabelling per row.
  const contradictionRows = contradictions.slice(0, 20);
  const contradictionLabels = labelList(contradictionRows);
  const busiestRows = [...annotated]
    .filter((c) => c.messages > 0)
    .sort((a, b) => b.messages - a.messages)
    .slice(0, full ? 50 : 10);
  const busiestLabels = labelList(busiestRows);
  const voiceUsed = voiceChannels.filter((c) => (c.voice_minutes ?? 0) > 0);

  const roleRows = roles
    .map((r) => {
      const flags = permissionFlags(r.permissions);
      return {
        name: r.name,
        position: r.position ?? 0,
        color: hexColor(r.color),
        hoisted: Boolean(r.hoist),
        managed: Boolean(r.managed),
        mentionable: Boolean(r.mentionable),
        members: r.member_count ?? null,
        permissions: flags,
        elevated: (flags ?? []).some((f) => ELEVATED.has(f)),
      };
    })
    .sort((a, b) => b.position - a.position);

  const elevated = roleRows.filter((r) => r.elevated);
  const changes = db
    .all('SELECT ts, kind, target, detail FROM structure_change ORDER BY ts DESC, id DESC LIMIT ?', full ? 40 : 10)
    .map((r) => ({
      at: iso(r.ts),
      kind: r.kind,
      target: safeLabel(r.target),
      detail: safeNote(r.detail),
    }));

  let settings = null;
  const rawSettings = db.getMeta('structure.guild');
  if (rawSettings) {
    try {
      settings = JSON.parse(rawSettings);
    } catch {
      settings = null;
    }
  }

  const coverage = {
    channels_total: annotated.length,
    visible_to_bot: visible.length,
    invisible_to_bot: invisible.length,
    visibility_unknown: unknownVisibility.length,
    invisible_share: annotated.length ? Math.round((invisible.length / annotated.length) * 1000) / 1000 : null,
    // Capped for payload size, but never silently: `invisible_to_bot` is the
    // true total and the truncation flag says the list is a sample of it.
    invisible_channels: labelList(invisible.slice(0, INVISIBLE_LIST_MAX)),
    invisible_channels_truncated: invisible.length > INVISIBLE_LIST_MAX,
    visibility_contradictions: {
      count: contradictions.length,
      channels: contradictionRows.map((c, i) => ({
        name: contradictionLabels[i],
        messages: c.messages,
        visible_to_bot: c.visible_to_bot,
      })),
      truncated: contradictions.length > 20,
      note:
        'Flagged invisible, yet they have collected activity, which is only possible for a ' +
        'channel the bot can read. The visibility map and the traffic disagree: most likely ' +
        'the permission changed part-way through the window, otherwise the flag is wrong. ' +
        'Do not describe these as a measurement gap and do not ask for View Channel to be ' +
        'granted — they are already being measured.',
    },
    note:
      'Message and voice totals only include channels the bot can see. Invisible channels are a ' +
      'measurement gap, not a quiet channel: a channel in this list may be busy and simply ' +
      'undercounted. To include one, grant the bot View Channel there.',
  };

  // Channels that belong to no category — including threads, whose parent is a
  // channel rather than a category — used to be missing from the rollup entirely.
  // That broke the invariant the comment below claims: the per-category numbers
  // did not add up to counts.channels (41 empty channels against 43 with no
  // traffic, 7 unused voice channels against 9 visible). They get a row of their
  // own so every channel is accounted for exactly once.
  const uncategorised = annotated.filter((c) => !c.parent_id || !categories.has(c.parent_id));

  const rollupCategory = (name, kids) => {
    const seen = kids.filter((c) => c.visible_to_bot === true);
    // Messages and voice are different measurements: a voice channel is never
    // expected to produce messages, so counting it as an "empty channel" (which
    // is what the old rollup did) inflates the pruning list with channels that
    // could not have been empty in any meaningful sense.
    const seenTalkable = seen.filter((c) =>
      ['text', 'announcement', 'forum', 'thread', 'media'].includes(c.type),
    );
    const seenVoice = seen.filter((c) => c.type === 'voice' || c.type === 'stage');
    // Traffic from children the bot cannot currently see is real, but including
    // it here would break the promise the coverage note makes — that invisible
    // channels are excluded from every activity figure. Split it out instead of
    // either hiding it or quietly folding it into a number that claims not to.
    const fromInvisible = kids
      .filter((c) => c.visible_to_bot !== true)
      .reduce((n, c) => n + c.messages, 0);
    const talkableKids = kids.filter((c) =>
      ['text', 'announcement', 'forum', 'thread', 'media'].includes(c.type),
    );
    return {
      name,
      channels: kids.length,
      visible_to_bot: seen.length,
      // null, not 0, when no visible child could have produced a message: nothing
      // there was measured, which is not the same as a quiet category. A category
      // with no text channels at all is the exception — zero messages is then a
      // fact about the category, not an absence of measurement, and reporting null
      // there contradicted activity_known: true.
      messages:
        seenTalkable.length > 0
          ? seenTalkable.reduce((n, c) => n + c.messages, 0)
          : talkableKids.length === 0 && seen.length > 0
            ? 0
            : null,
      // Same null rule as messages: for a category with nothing visible, "traffic
      // we can see exists in channels we cannot" is unknowable, and 0 would read
      // as "the invisible half of Archive is dead" rather than "unmeasured".
      messages_from_invisible: seen.length > 0 ? fromInvisible : null,
      empty_channels: seenTalkable.filter((c) => c.messages === 0).length,
      unused_voice_channels: seenVoice.filter((c) => (c.voice_minutes ?? 0) === 0).length,
      activity_known: seen.length > 0,
    };
  };

  const summaryCategories = [...categories.values()]
    .sort((a, b) => b.position - a.position)
    .map((cat) => rollupCategory(cat.name, annotated.filter((c) => c.parent_id === cat.channel_id)));

  // Empty categories are kept deliberately: a category with nothing in it is the
  // easiest clutter to remove, and dropping it also broke the invariant that the
  // category rollup accounts for every channel in counts.channels.
  if (uncategorised.length > 0) summaryCategories.push(rollupCategory('(no category)', uncategorised));

  const payload = {
    available: true,
    window: spellWindow(window.label),
    observed_at: observedTs ? iso(observedTs) : null,
    counts: {
      channels: annotated.length,
      categories: categories.size,
      by_type: byType,
      roles: roleRows.length,
      uncategorised_channels: uncategorised.length,
    },
    coverage,
    guild: settings,
    permission_audit: {
      roles_total: roleRows.length,
      elevated_roles: elevated.map((r) => ({ name: r.name, members: r.members, permissions: r.permissions })),
      elevated_note:
        elevated.length === 0
          ? 'No role carries administrator, manage_guild or manage_roles.'
          : 'These roles can reshape the server. In a community that hands out roles, this list is ' +
            'the one to review periodically; it is also the list of roles whose compromise matters.',
      roles_with_administrator: roleRows.filter((r) => (r.permissions ?? []).includes('administrator'))
        .length,
      // null means the role was not captured; [] means it was captured and holds
      // none of the audited bits — which is the normal case for @everyone.
      everyone_role: roleRows.find((r) => r.name === '@everyone')?.permissions ?? null,
      note:
        'Flags are read from the role bitfield. Only the bits that change what a server can do to ' +
        'itself are named, so an empty list means none of those are set, not that the role has no ' +
        'permissions. Channel-level overwrites can grant a permission that the role lacks and vice ' +
        'versa, so this audits the roles, not the effective permission of any given member.',
    },
    activity: {
      // `busiest` also lists channels now flagged invisible (they were readable
      // earlier in the window), so both counts are given: the visible-only figure
      // is the one that adds up against talkable_channels_visible.
      channels_with_traffic: annotated.filter((c) => c.messages > 0).length,
      visible_channels_with_traffic: talkable.filter((c) => c.messages > 0).length,
      talkable_channels_visible: talkable.length,
      channels_with_no_traffic: unusedVisible.length,
      no_traffic_channels: labelList(unusedVisible.slice(0, NO_TRAFFIC_LIST_MAX)),
      no_traffic_channels_truncated: unusedVisible.length > NO_TRAFFIC_LIST_MAX,
      voice_channels_visible: voiceChannels.length,
      voice_channels_used: voiceUsed.length,
      busiest: busiestRows.map((c, i) => ({
        name: busiestLabels[i],
        type: c.type,
        messages: c.messages,
        active_days: c.active_days,
        // This list deliberately includes channels now flagged invisible, so each
        // row says which it is: otherwise a reader quotes "pokemon is the third
        // busiest channel" without knowing it is also a coverage contradiction.
        visible_to_bot: c.visible_to_bot === true,
      })),
    },
    categories: summaryCategories,
    changes,
    caveats: [
      'Channels the bot cannot see are excluded from every activity figure; see coverage.invisible_channels.',
      'Channel topics are not collected at all. They routinely hold webhook URLs and invite links, ' +
        'and nothing here needs them.',
      'Role member counts are null when the member cache is incomplete, because a partial cache ' +
        'silently undercounts.',
      'Structure is captured as a snapshot plus change events. A rename that happened before ' +
        'collection began is invisible; only the current name is known.',
      'counts.channels excludes categories. Discord counts the category objects as channels, so ' +
        'the guild block and the API summary report a larger number for the same server; ' +
        'counts.channels + counts.categories equals that figure.',
      'A category with zero visible channels reports messages: null and activity_known: false, ' +
        'because nothing there was measured. Zero would mean the category was watched and quiet. ' +
        'A category with no text channels at all reports messages: 0 instead, because zero is then ' +
        'a fact about the category rather than an absence of measurement.',
      'The "(no category)" row collects channels that belong to no category, including threads ' +
        '(whose parent is a channel, not a category). It exists so the rollup accounts for every ' +
        'channel in counts.channels: the per-category channels, empty_channels and ' +
        'unused_voice_channels all sum to their activity.* counterparts.',
      'voice_channels_visible counts stage channels as well as voice channels, because a stage ' +
        'carries voice; counts.by_type separates the two.',
    ],
  };

  if (full) {
    payload.channels = annotated;
    payload.roles = roleRows;
    payload.uncategorised = uncategorised;
  }

  return payload;
}

/**
 * Discord's GuildScheduledEventStatus is an enum (1..4). Passing the raw number
 * through made the API say "status": 2.0, which reads as a score, not a state.
 */
const EVENT_STATUS_LABEL = {
  1: 'scheduled',
  2: 'active',
  3: 'completed',
  4: 'canceled',
  5: 'canceled',
};

export function events(db, config, { ts = now() } = {}) {
  const rows = db.all(
    `SELECT event_id, name, start_ts, end_ts, user_count, status, observed_ts
       FROM guild_event
      ORDER BY COALESCE(start_ts, 0) DESC
      LIMIT 50`,
  );

  return {
    events: rows.map((r) => ({
      id: r.event_id,
      name: r.name,
      starts: r.start_ts ? iso(r.start_ts) : null,
      ends: r.end_ts ? iso(r.end_ts) : null,
      // The collector stores this as TEXT ("2.0"), so coerce before the lookup.
      status: EVENT_STATUS_LABEL[Number(r.status)] ?? 'unknown',
      turnout: r.user_count,
      observed_at: iso(r.observed_ts),
      stale: ts - r.observed_ts > 24 * HOUR,
    })),
    caveats: [
      'turnout is Discord subscriberCount at observation time, not actual attendance.',
      'Events created and deleted between polls are not observed.',
    ],
    quality: quality(db, config, ts),
  };
}

/**
 * Gini coefficient of the message distribution. 0 is everyone-equal, 1 is one
 * member writing everything. Takes a descending array.
 */
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
 * How unevenly activity is spread across members.
 *
 * Aggregate totals and an online count cannot distinguish a healthy community
 * from fifteen people and a thousand lurkers. This is the query that can, and
 * it returns only derived statistics — no pseudonym is ever emitted.
 */
export function engagement(db, config, { window, ts = now() }) {
  const from = cutoff(window, ts);
  const coverage = coverageCaveat(db, config, from, ts);
  const hourlyCutoff = ts - config.storage.retentionHourlyDays * DAY;
  const effectiveFrom = Math.max(from, hourlyCutoff);
  const capped = window.label === 'all' || from < hourlyCutoff;

  if (config.privacy.perMemberCounters !== 'hmac') {
    return {
      window: window.label,
      available: false,
      reason:
        'PER_MEMBER_COUNTERS is off, so no per-member rows are stored and concentration cannot be computed.',
      quality: quality(db, config, ts),
    };
  }

  const rows = db
    .all(
      `SELECT user_hmac, SUM(messages) AS messages, SUM(voice_s) AS voice_s
         FROM member_hour
        WHERE hour_ts >= ?
        GROUP BY user_hmac`,
      effectiveFrom,
    )
    .filter((r) => (r.messages ?? 0) > 0);

  const messages = rows.map((r) => r.messages).sort((a, b) => b - a);
  const total = messages.reduce((a, b) => a + b, 0);
  const active = messages.length;

  if (active === 0) {
    return {
      window: window.label,
      available: true,
      active_members: 0,
      total_messages: 0,
      concentration: null,
      note: 'No per-member message rows in this window yet, so concentration has nothing to measure.',
      caveats: [
        ...(coverage ? [coverage] : []),
        `Counts only members who sent at least one message since ${iso(effectiveFrom)}; everyone else is a lurker.`,
      ],
      quality: quality(db, config, ts),
    };
  }

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

  const bands = [
    ['1-9', (n) => n >= 1 && n < 10],
    ['10-49', (n) => n >= 10 && n < 50],
    ['50-199', (n) => n >= 50 && n < 200],
    ['200-999', (n) => n >= 200 && n < 1000],
    ['1000+', (n) => n >= 1000],
  ];
  const distribution = {};
  for (const [label, test] of bands) distribution[label] = messages.filter(test).length;

  const snap = db.get('SELECT members, bots FROM snapshot ORDER BY ts DESC LIMIT 1');
  const humans = snap ? snap.members - snap.bots : null;

  return {
    window: window.label,
    available: true,
    window_effective_from: iso(effectiveFrom),
    window_capped: capped,
    active_members: active,
    total_messages: total,
    concentration: {
      members_for_80_percent_of_messages: membersFor80,
      share_of_messages_from_top_10_percent: Number(topShare.toFixed(3)),
      median_messages_per_active_member: median,
      gini: gini(messages),
      distribution,
    },
    lurkers: {
      humans,
      active_members: active,
      active_share_of_humans:
        humans && humans > 0 ? Number((active / humans).toFixed(3)) : null,
    },
    caveats: [
      ...(coverage ? [coverage] : []),
      `Counts only members who sent at least one message since ${iso(effectiveFrom)}; everyone else is a lurker.`,
      `Capped to hourly retention (${config.storage.retentionHourlyDays} days): older per-member rows are pruned.`,
      'Members are pseudonymous HMACs, never IDs. Ranks are computed in-process and no per-member row is returned.',
      'Needs several weeks of per-member rows before the distribution is stable.',
    ],
    quality: quality(db, config, ts),
  };
}

/**
 * Operator-declared event windows, each expressed against a trailing baseline.
 *
 * Discord's scheduled events cannot represent what a community actually runs (a 5v5
 * tourney, a token-prize night), so those windows have to be declared. Without
 * the declaration every post-event question starts with "compared to what?".
 */
/**
 * Why a tag's figures are what they are. Several of these can be true at once -
 * a tournament that started before install and has no prior baseline is both
 * partially observed and uncomparable - so they are collected, not chained.
 */
function tagNotes({
  status,
  observable,
  seenHours,
  windowHours,
  partial,
  ratesMeaningful,
  baselineDays,
  baselineObserved,
  baselineMeasurable,
  baselineCoveredDays,
  collectionLabel,
}) {
  if (status === 'upcoming') {
    return (
      'This event has not started, so there is no measured activity or uplift yet. baseline is ' +
      'the trailing per-day rate it will be compared against.' +
      // Without this the nulls look like missing data rather than a window that
      // has barely been collected, and the sentence above reads as if a rate
      // exists.
      (baselineMeasurable
        ? ''
        : ' Its own baseline is not established yet either: less than a day of the ' +
          `${baselineDays}-day window has been collected so far, and a partial day cannot ` +
          'stand in for a per-day rate.')
    );
  }

  const notes = [];
  if (!observable) {
    notes.push(
      `This event ended before collection began (${collectionLabel}), so no messages or voice ` +
        "can be measured for it. during.joins comes from each member's join date and counts " +
        'current members only.',
    );
  } else if (partial) {
    notes.push(
      // Avoids "1 ... were observed": the count can be 0.8 or 1, and every verb
      // agreement that fits one reads wrong for the other.
      `Coverage: ${seenHours} of the ${windowHours} hours this event has run so far ` +
        `(collection began ${collectionLabel}). during totals cover the observed part only` +
        (ratesMeaningful
          ? '; rates use that same span.'
          : `, and ${seenHours} ${seenHours === 1 ? 'hour' : 'hours'} is too short for a daily ` +
            'rate to mean anything, so the ' +
            'per-day figures are null until more has been collected.'),
    );
  }
  if (observable && !baselineMeasurable) {
    notes.push(
      baselineCoveredDays === 0
        ? `No usable baseline: the ${baselineDays}-day baseline window closes before collection ` +
          `began (${collectionLabel}), so there is nothing to compare this event against. ` +
          'baseline rates and uplift are null for this event.'
        : // No number here: the payload reports days_covered to two decimals and this
          // sentence rounded to one, so it read 0.05 in one field and 0.1 in the next.
          `No usable baseline: less than a day of the ${baselineDays}-day window has been ` +
          'collected so far, and a partial day cannot stand in for a per-day rate. ' +
          'baseline rates and uplift are null for this event.',
    );
  } else if (observable && baselineObserved === 0) {
    notes.push(
      `There is no baseline data before this event: collection began ${collectionLabel}, and the ` +
        `${baselineDays}-day baseline ends where the event starts, so uplift cannot be computed.`,
    );
  }
  return notes.length ? notes.join(' ') : undefined;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const weekdayOf = (ts) => new Date(ts * 1000).getUTCDay();

/**
 * Hours of [from, to) that fall on each UTC weekday, fractional at the edges.
 *
 * Matching by *hours* rather than by whole days is what makes a three-hour evening
 * event comparable to a 24-hour baseline day: three Saturday-evening hours are
 * 3/24 of a Saturday, not a whole one.
 */
function hoursByWeekday(from, to) {
  const hours = new Array(7).fill(0);
  for (let h = hourOf(from); h < to; h += HOUR) {
    const start = Math.max(h, from);
    const end = Math.min(h + HOUR, to);
    if (end > start) hours[weekdayOf(h)] += (end - start) / HOUR;
  }
  return hours;
}

/**
 * A weekday-matched baseline.
 *
 * The trailing average answers "how busy was this server per day" and is the wrong
 * denominator for a weekend tournament: Saturday and Sunday are not average days,
 * so a perfectly ordinary weekend event shows "uplift" that is really the weekly
 * cycle. This walks every day of the baseline window, keeps the ones that were
 * actually observed, and averages per weekday — so the comparison is Saturday
 * against Saturdays.
 *
 * Days are enumerated from the calendar, not from the activity tables, so a
 * baseline day with genuinely no messages counts as a zero rather than vanishing.
 * A day the collector was down is excluded when heartbeats exist, because a down
 * day is not a quiet day and counting it as zero inflates every uplift.
 */
function weekdayBaseline(db, { baseFrom, baseEnd, installDay, partialDays, notAfter = Infinity }) {
  // A baseline cannot include a day that has not finished. An event tagged for next
  // week has a baseline window that reaches into the future, and enumerating those
  // days as zeroes dragged the mean down (35.7/day became 23.2/day) without any
  // day having been observed at all.
  const lastCompleteDay = dayOf(notAfter) - DAY;
  const heartbeatDays = new Set(
    db.all('SELECT day_ts FROM collector_day WHERE day_ts >= ? AND day_ts < ?', baseFrom, baseEnd)
      .map((r) => r.day_ts),
  );
  const heartbeatsAvailable = heartbeatDays.size > 0;

  const messagesByDay = new Map(
    db
      .all(
        `SELECT day_ts, SUM(messages) AS v FROM message_day
          WHERE day_ts >= ? AND day_ts < ? GROUP BY day_ts`,
        baseFrom,
        baseEnd,
      )
      .map((r) => [r.day_ts, r.v]),
  );
  const voiceByDay = new Map(
    db
      .all(
        `SELECT day_ts, SUM(seconds) AS v FROM voice_day
          WHERE day_ts >= ? AND day_ts < ? GROUP BY day_ts`,
        baseFrom,
        baseEnd,
      )
      .map((r) => [r.day_ts, r.v]),
  );
  const joinsByDay = new Map(
    db
      .all(
        `SELECT day_ts, SUM(joins) AS v FROM growth_day
          WHERE day_ts >= ? AND day_ts < ? GROUP BY day_ts`,
        baseFrom,
        baseEnd,
      )
      .map((r) => [r.day_ts, r.v]),
  );

  // Which days count as baseline days.
  //
  // With heartbeats, every finished day the collector was alive is a real day,
  // including one with no activity: a quiet day is a zero and belongs in the mean.
  //
  // Without heartbeats — data collected before this table existed — a day with no
  // rows is *unknown*, not zero. Counting those as zeros understates the baseline
  // and therefore inflates every uplift, so the fallback only uses days that carry
  // a recorded row. That can overstate the rate on a quiet server, which biases
  // uplift down; understating an event's impact is the safer error.
  const activityDays = new Set([
    ...messagesByDay.keys(),
    ...voiceByDay.keys(),
    ...joinsByDay.keys(),
  ]);
  const usableDay = (d) =>
    d >= installDay &&
    d <= lastCompleteDay &&
    !partialDays.has(d) &&
    (heartbeatsAvailable ? heartbeatDays.has(d) : activityDays.has(d));

  const days = [];
  for (let d = dayOf(baseFrom); d < baseEnd; d += DAY) {
    if (usableDay(d)) days.push(d);
  }

  const sums = {
    messages: new Array(7).fill(0),
    voice: new Array(7).fill(0),
    joins: new Array(7).fill(0),
  };
  const counts = new Array(7).fill(0);
  let totalMessages = 0;
  let totalVoice = 0;
  let totalJoins = 0;

  for (const d of days) {
    const dow = weekdayOf(d);
    const m = messagesByDay.get(d) ?? 0;
    const v = voiceByDay.get(d) ?? 0;
    const j = joinsByDay.get(d) ?? 0;
    sums.messages[dow] += m;
    sums.voice[dow] += v;
    sums.joins[dow] += j;
    counts[dow] += 1;
    totalMessages += m;
    totalVoice += v;
    totalJoins += j;
  }

  const mean = (arr, dow) => (counts[dow] > 0 ? arr[dow] / counts[dow] : null);
  return {
    days_used: days.length,
    days_by_weekday: Object.fromEntries(WEEKDAY_NAMES.map((name, i) => [name, counts[i]])),
    messages_per_day_by_weekday: Object.fromEntries(
      WEEKDAY_NAMES.map((name, i) => [name, mean(sums.messages, i)]),
    ),
    mean_messages_per_day: days.length > 0 ? totalMessages / days.length : null,
    mean_voice_hours_per_day: days.length > 0 ? totalVoice / 3600 / days.length : null,
    mean_joins_per_day: days.length > 0 ? totalJoins / days.length : null,
    sums,
    counts,
    heartbeats_available: heartbeatsAvailable,
  };
}

/**
 * Expected activity for a window, given hours per weekday and a matched baseline.
 *
 * Returns null for a metric when any weekday the window touches has too few
 * baseline days to average: a mean over two Saturdays is not a baseline, and
 * silently using it is how a lucky weekend becomes a 3x "uplift".
 */
function expectation(hours, matched, key, minDays) {
  const thin = [];
  let expected = 0;
  for (let dow = 0; dow < 7; dow += 1) {
    if (hours[dow] <= 0) continue;
    if (matched.counts[dow] < minDays) {
      thin.push(WEEKDAY_NAMES[dow]);
      continue;
    }
    expected += (hours[dow] / 24) * (matched.sums[key][dow] / matched.counts[dow]);
  }
  if (thin.length > 0) return { thin };
  return { expected };
}

function tagImpact(db, tag, config, { hourlyCutoff, ts }) {
  const baselineDays = config.analytics.eventBaselineDays;
  const noisyDays = config.analytics.eventBaselineNoisyDays;
  const minMessages = config.analytics.eventUpliftMinMessages;
  const minMatchedDays = config.analytics.eventMatchedMinDays;
  const start = tag.start_ts;
  const end = Math.max(tag.end_ts, tag.start_ts + HOUR);
  const endBounded = Math.min(end, ts);
  const windowSpanDays = Math.max((endBounded - start) / DAY, 1 / 24);
  const hourly = end >= hourlyCutoff;

  // A tournament tagged from its first match to its final often starts before
  // the bot was installed. Dividing measured messages by the whole window then
  // divides real activity by days that could never have produced any, which
  // reports a loud event as a quiet one. Rates use the observed span; the raw
  // totals are unaffected because they were only ever summed over real rows.
  const collectionFrom = collectionStart(db);
  const seenFrom = collectionFrom === null ? start : Math.max(start, collectionFrom);
  const seenTo = endBounded;
  const observable = seenTo > seenFrom;
  const seenSpanDays = observable ? Math.max((seenTo - seenFrom) / DAY, 1 / 24) : 0;

  const messagesDuring = hourly
    ? db.get(
        'SELECT COALESCE(SUM(messages),0) AS v FROM message_hour WHERE hour_ts >= ? AND hour_ts < ?',
        start,
        endBounded,
      ).v
    : db.get(
        'SELECT COALESCE(SUM(messages),0) AS v FROM message_day WHERE day_ts >= ? AND day_ts < ?',
        dayOf(start),
        endBounded,
      ).v;

  const secondsDuring = hourly
    ? db.get(
        'SELECT COALESCE(SUM(seconds),0) AS v FROM voice_hour WHERE hour_ts >= ? AND hour_ts < ?',
        start,
        endBounded,
      ).v
    : db.get(
        'SELECT COALESCE(SUM(seconds),0) AS v FROM voice_day WHERE day_ts >= ? AND day_ts < ?',
        dayOf(start),
        endBounded,
      ).v;

  // Joins survive a window that predates install: each current member carries
  // the date they joined, so "did this event bring anyone in" is answerable
  // retroactively even when no message was ever counted. Departed members are
  // invisible, so it is a floor.
  const measuredJoinsDuring = db.get(
    'SELECT COALESCE(SUM(joins),0) AS v FROM growth_day WHERE day_ts >= ? AND day_ts < ?',
    dayOf(start),
    endBounded,
  ).v;
  const earliestMeasured =
    db.get('SELECT MIN(day_ts) AS v FROM growth_day WHERE day_ts >= ?', dayOf(start))?.v ?? null;
  const backfillJoinsDuring =
    start < (earliestMeasured ?? endBounded)
      ? db.get(
          'SELECT COALESCE(SUM(joins),0) AS v FROM growth_backfill WHERE day_ts >= ? AND day_ts < ?',
          dayOf(start),
          Math.min(earliestMeasured ?? endBounded, endBounded),
        ).v
      : 0;
  const joinsDuring = measuredJoinsDuring + backfillJoinsDuring;

  // Baseline always reads daily rows: they outlive hourly ones, so a tag inside
  // hourly retention still gets a full-length comparison.
  //
  // It is anchored to whole days, not to `start - baselineDays`. Anchoring at a mid-day
  // instant made the first baseline day partially in range while its row is a
  // whole-day total: either that day is dropped (under-counting the baseline, so
  // uplift looks bigger than it is) or, if the instant is early enough in the
  // day, it is counted at full weight for a few hours of real data. Whole days
  // also keep the event's own day out of its control group.
  const baseEnd = dayOf(start);
  const baseFrom = baseEnd - baselineDays * DAY;
  const baseMsg = db.get(
    'SELECT COALESCE(SUM(messages),0) AS v, COUNT(DISTINCT day_ts) AS days, MIN(day_ts) AS first_day FROM message_day WHERE day_ts >= ? AND day_ts < ?',
    baseFrom,
    baseEnd,
  );
  const baseVoice = db.get(
    'SELECT COALESCE(SUM(seconds),0) AS v FROM voice_day WHERE day_ts >= ? AND day_ts < ?',
    baseFrom,
    baseEnd,
  );
  const baseJoins = db.get(
    'SELECT COALESCE(SUM(joins),0) AS v FROM growth_day WHERE day_ts >= ? AND day_ts < ?',
    baseFrom,
    baseEnd,
  );

  // Divide by the part of the baseline that was actually observed: the overlap of
  // [baseFrom, baseEnd) with [install, now]. Two wrong answers this avoids:
  // dividing by days-with-rows inflates the rate on a quiet server, where a
  // silent day is a real zero; dividing by the calendar span from the first row
  // dilutes it by days that were never collected (an event tagged for next week
  // had a 4-day span holding one partial day of data, so 2 messages read as
  // 0.5/day instead of 48/day).
  const install = collectionStart(db);
  const baseObsFrom = Math.max(baseFrom, install ?? baseFrom);
  const baseObsTo = Math.min(baseEnd, ts);
  const coveredDays = Math.max(0, Math.min((baseObsTo - baseObsFrom) / DAY, baselineDays));
  // Below a full day there is no baseline rate worth quoting: it is one partial
  // day wearing a per-day label.
  const baselineMeasurable = coveredDays >= 1;
  const days = Math.max(coveredDays, 1);
  // A partial window less than six hours in has too few events for a daily rate
  // to mean anything (2 messages in 1 hour is not 47.7/day). Totals stay; the
  // rates go null rather than inviting a quote that cannot survive scrutiny.
  const seenHoursExact = (seenTo - seenFrom) / 3600;
  const fullyObserved = seenSpanDays >= windowSpanDays - 1e-9;
  const ratesMeaningful = observable && (fullyObserved || seenHoursExact >= 6);
  const messagesPerDay = ratesMeaningful ? messagesDuring / seenSpanDays : null;
  const voiceHoursPerDay = ratesMeaningful ? secondsDuring / 3600 / seenSpanDays : null;
  const baseMessagesPerDay = baselineMeasurable ? (baseMsg?.v ?? 0) / days : null;
  const baseVoicePerDay = baselineMeasurable ? (baseVoice?.v ?? 0) / 3600 / days : null;
  const baseJoinsPerDay = baselineMeasurable ? (baseJoins?.v ?? 0) / days : null;

  // A tag whose window has not opened yet is not "ongoing": an event tagged for
  // next week would otherwise be reported as happening right now, and its
  // near-zero activity read as a failed event.
  const status = ts < start ? 'upcoming' : ts < end ? 'ongoing' : 'past';

  // ------------------------------------------------- matched baseline + uplift
  const partialDays = new Set(
    db
      .all(
        `SELECT day_ts FROM message_day WHERE partial = 1 AND day_ts >= ? AND day_ts < ?
         UNION SELECT day_ts FROM voice_day WHERE partial = 1 AND day_ts >= ? AND day_ts < ?`,
        baseFrom,
        baseEnd,
        baseFrom,
        baseEnd,
      )
      .map((r) => r.day_ts),
  );
  const matched = weekdayBaseline(db, {
    baseFrom,
    baseEnd,
    installDay: install === null ? -Infinity : dayOf(install),
    partialDays,
    notAfter: ts,
  });
  const hours = observable ? hoursByWeekday(seenFrom, seenTo) : new Array(7).fill(0);

  // Two tagged events in the same hours cannot be told apart: the uplift of one is
  // partly the other. Refusing is the only honest answer.
  const overlaps = db.all(
    `SELECT id, name, start_ts, end_ts FROM event_tag
      WHERE id <> ? AND start_ts < ? AND end_ts > ?`,
    tag.id,
    end,
    start,
  );

  const refused = [];
  const upliftStatus = (metric, code, detail, remedy) => {
    refused.push({ metric, code, detail, remedy: remedy ?? null });
    return { status: 'refused', code, value: null };
  };

  const blocked = (() => {
    if (status === 'upcoming') {
      return ['not_started', 'The event has not started, so there is no window to measure.'];
    }
    if (!observable) {
      return [
        'window_unobserved',
        'The event ended before collection began, so no message or voice row covers it.',
      ];
    }
    if (!ratesMeaningful) {
      return [
        'window_too_short',
        `Only ${Number(seenHoursExact.toFixed(1))} hours of the window have been observed; a ` +
          'per-day rate needs at least six.',
      ];
    }
    if (overlaps.length > 0) {
      return [
        'overlapping_event',
        `Another tagged window overlaps this one (${overlaps
          .map((o) => `#${o.id}`)
          .join(', ')}), so activity cannot be attributed to either.`,
      ];
    }
    if (!baselineMeasurable) {
      return [
        'baseline_unmeasurable',
        'Less than a day of the baseline window has been collected, and a partial day cannot ' +
          'stand in for a per-day rate.',
      ];
    }
    if ((baseMsg?.days ?? 0) < noisyDays) {
      return [
        'baseline_too_short',
        `Only ${baseMsg?.days ?? 0} baseline days have activity; ` +
          `EVENT_BASELINE_NOISY_DAYS asks for ${noisyDays} before a ratio is quoted.`,
      ];
    }
    return null;
  })();

  const uplift = {};
  const upliftStatusMap = {};
  let publishedAny = false;

  const metrics = [
    {
      key: 'messages',
      actual: messagesDuring,
      hours,
      minVolume: minMessages,
      format: (v) => Number(v.toFixed(2)),
    },
    { key: 'voice', actual: secondsDuring / 3600, hours, minVolume: 0, format: (v) => Number(v.toFixed(2)) },
    { key: 'joins', actual: joinsDuring, hours, minVolume: 0, format: (v) => Number(v.toFixed(2)) },
  ];

  for (const metric of metrics) {
    if (blocked) {
      uplift[metric.key] = null;
      upliftStatusMap[metric.key] = { status: 'refused', code: blocked[0] };
      continue;
    }
    const exp = expectation(metric.hours, matched, metric.key, minMatchedDays);
    if (exp.thin) {
      uplift[metric.key] = null;
      upliftStatusMap[metric.key] = {
        status: 'refused',
        code: 'matched_baseline_thin',
        detail: `Not enough baseline days for ${exp.thin.join(', ')} (${minMatchedDays} needed per weekday).`,
      };
      continue;
    }
    if (exp.expected <= 0) {
      uplift[metric.key] = null;
      upliftStatusMap[metric.key] = {
        status: 'refused',
        code: 'no_baseline_activity',
        detail: 'The matched baseline predicts no activity in this window, so a ratio is undefined.',
      };
      continue;
    }
    if (metric.minVolume > 0 && metric.actual < metric.minVolume) {
      uplift[metric.key] = null;
      upliftStatusMap[metric.key] = {
        status: 'refused',
        code: 'insufficient_volume',
        detail: `${metric.actual} in the window is below EVENT_UPLIFT_MIN_MESSAGES=${metric.minVolume}.`,
      };
      continue;
    }
    uplift[metric.key] = metric.format(metric.actual / exp.expected);
    upliftStatusMap[metric.key] = {
      status: 'published',
      basis: 'weekday_matched',
      expected: Number(exp.expected.toFixed(2)),
    };
    publishedAny = true;
  }

  const refusalCodes = [...new Set(refused.map((r) => r.code).concat(
    Object.values(upliftStatusMap)
      .filter((s) => s.status === 'refused')
      .map((s) => s.code),
  ))];

  return {
    id: tag.id,
    name: safeLabel(tag.name),
    kind: safeLabel(tag.kind),
    prize: safeLabel(tag.prize),
    participants: tag.participants ?? null,
    notes: safeNote(tag.notes),
    starts: iso(start),
    ends: iso(end),
    duration_hours: Number(((end - start) / 3600).toFixed(1)),
    status,
    ongoing: start <= ts && end > ts,
    granularity: hourly ? 'hour' : 'day',
    // An unstarted event has no measurement, and a zero is not the same thing:
    // "0 messages, uplift 0" reads as a flop rather than as "not yet". Nulls
    // force the model to say it has nothing to measure yet.
    during:
      status === 'upcoming'
        ? null
        : {
            messages: observable ? messagesDuring : null,
            messages_per_day: ratesMeaningful ? Number(messagesPerDay.toFixed(1)) : null,
            voice_hours: observable ? Number((secondsDuring / 3600).toFixed(2)) : null,
            joins: joinsDuring,
            joins_basis:
              joinsDuring === 0
                ? null
                : measuredJoinsDuring > 0 && backfillJoinsDuring > 0
                  ? 'mixed'
                  : backfillJoinsDuring > 0
                    ? 'backfill'
                    : 'measured',
            observed: observable
              ? {
                  from: iso(seenFrom),
                  to: iso(seenTo),
                  hours: Number(((seenTo - seenFrom) / 3600).toFixed(1)),
                  complete: seenSpanDays >= windowSpanDays - 1e-9,
                }
              : null,
          },
    baseline: {
      window_days: baselineDays,
      messages_per_day: baseMessagesPerDay === null ? null : Number(baseMessagesPerDay.toFixed(1)),
      voice_hours_per_day: baseVoicePerDay === null ? null : Number(baseVoicePerDay.toFixed(2)),
      joins_per_day: baseJoinsPerDay === null ? null : Number(baseJoinsPerDay.toFixed(2)),
      days_observed: Number(baseMsg?.days ?? 0),
      // Unclamped: a baseline that predates collection is covered by 0 days, and
      // a 1 here contradicted days_observed: 0 while the rates divided by 1.
      days_covered: Number(coveredDays.toFixed(2)),
      // The uplift denominator. Trailing averages are kept above for context and
      // comparability; these are what the ratio actually divides by.
      matched: {
        method: 'weekday_matched',
        days_used: matched.days_used,
        days_by_weekday: matched.days_by_weekday,
        messages_per_day_by_weekday: matched.messages_per_day_by_weekday,
        mean_messages_per_day:
          matched.mean_messages_per_day === null
            ? null
            : Number(matched.mean_messages_per_day.toFixed(1)),
        mean_voice_hours_per_day:
          matched.mean_voice_hours_per_day === null
            ? null
            : Number(matched.mean_voice_hours_per_day.toFixed(2)),
        mean_joins_per_day:
          matched.mean_joins_per_day === null ? null : Number(matched.mean_joins_per_day.toFixed(2)),
        min_days_per_weekday: minMatchedDays,
        heartbeats_available: matched.heartbeats_available,
        note: matched.heartbeats_available
          ? 'Baseline days with a known collection gap are excluded; a day the collector was ' +
            'down is not a quiet day, and counting it as zero inflates uplift.'
          : 'No heartbeats were recorded for this window (data predates collector_day), so only ' +
            'days with a recorded row are used. Counting unobserved days as zeros would ' +
            'understate the baseline and inflate uplift.'
      },
    },
    // No baseline rows at all means the ratio would divide by zero and read as a
    // confident "no impact". Say null instead and explain why.
    uplift: publishedAny ? uplift : null,
    uplift_status: upliftStatusMap,
    refusal_codes: refusalCodes,
    refusals: refused,
    overlapping_events: overlaps.length
      ? overlaps.map((o) => ({ id: o.id, name: safeLabel(o.name) }))
      : [],
    note: tagNotes({
      status,
      observable,
      seenHours: Number(seenHoursExact.toFixed(1)),
      windowHours: Number(((endBounded - start) / 3600).toFixed(1)),
      partial: !fullyObserved,
      ratesMeaningful,
      baselineDays,
      baselineObserved: Number(baseMsg?.days ?? 0),
      baselineMeasurable,
      baselineCoveredDays: Number(coveredDays.toFixed(1)),
      collectionLabel: collectionStartLabel(db),
    }),
  };
}

export function tags(db, config, { limit = 20, ts = now() } = {}) {
  const rows = db.all(
    `SELECT id, name, start_ts, end_ts, kind, prize, participants, notes
       FROM event_tag
      ORDER BY start_ts DESC, id DESC
      LIMIT ?`,
    limit,
  );

  const hourlyCutoff = ts - config.storage.retentionHourlyDays * DAY;

  return {
    tags: rows.map((r) => tagImpact(db, r, config, { hourlyCutoff, ts })),
    count: rows.length,
    // Ties on start_ts used to come back in whatever order SQLite felt like, so
    // a truncated list could drop an event the operator cared about.
    order: 'newest first (start_ts desc); raise limit to see older tags',
    caveats: [
      'Tags are declared by an operator with the tag CLI, not inferred from Discord. Nothing is tagged until someone adds it.',
      `uplift divides the activity observed inside the window by a weekday-matched baseline built from the ` +
        `trailing ${config.analytics.eventBaselineDays} days: a Saturday event is compared with Saturdays, ` +
        'because the average day is not a weekend. It is correlation, not proof of cause.',
      `baseline.messages_per_day is the plain trailing average, kept for context; baseline.matched is the ` +
        'denominator uplift actually uses. The two differ on any server with a weekly rhythm, and quoting ' +
        'the first as if it were the second overstates weekend events.',
      `A baseline with fewer than ${config.analytics.eventBaselineNoisyDays} days observed is refused ` +
        'rather than quoted with a warning: an uplift derived from a week of history does not survive ' +
        'a second look.',
      'A refusal is not a zero. uplift_status says per metric whether the figure was published or ' +
        'refused, refusal_codes lists why, and during still reports what was measured.',
      'Two overlapping tagged windows cannot be attributed, so they refuse uplift and name each other.',
    ],
    quality: quality(db, config, ts),
  };
}

export { CAVEATS };
