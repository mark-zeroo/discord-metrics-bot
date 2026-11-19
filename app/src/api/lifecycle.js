import { DAY, iso, isoDate, dayOf } from '../time.js';
import { STATUS_LEGEND } from './suppression.js';

/**
 * Channel lifecycle: is this channel new, growing, fading, dead, or not measured?
 *
 * The four questions this has to keep apart, because the naive classification
 * collapses them:
 *
 *   empty vs unmeasured — a channel the bot cannot see has *no* message count, not
 *     a count of zero. Reporting 0 for it makes a busy staff channel look like a
 *     pruning candidate and hides a measurement gap at the same time.
 *   quiet vs dormant — "no traffic in this window" is not "nobody goes there";
 *     dormant requires a previous active period and `channelDormantDays` of silence
 *     since, and never applies to a channel that was only created last week.
 *   new vs never used — a channel created during the window with no traffic is
 *     still being adopted. One that has existed for a year without a single message
 *     is a different decision.
 *   declining vs too quiet to say — a channel with 12 messages in the window did
 *     not "decline 40%"; it is below the volume at which a trend exists.
 *
 * `structure_change` is the only source for a creation date, and it only knows
 * channels created after install (the first refresh records a single baseline row
 * rather than one creation per existing channel). So `created` is null for older
 * channels, and the classifier falls back to first observed activity.
 */

const DORMANT_TREND_THRESHOLD = 0.25; // +/-25% between halves is a trend, inside is noise

const TALKABLE = new Set(['text', 'announcement', 'forum', 'thread', 'media']);

export function channelLifecycle(
  db,
  config,
  { window, limit = 25, ts = Math.floor(Date.now() / 1000) } = {},
) {
  const dormantDays = config.analytics.channelDormantDays;
  const minMessages = config.analytics.channelMinMessages;
  const from = window.label === 'all' ? 0 : ts - window.seconds;
  const windowStart = dayOf(from);
  const today = dayOf(ts);
  const dormantCutoff = ts - dormantDays * DAY;

  const channels = db.all("SELECT * FROM channel_meta WHERE type <> 'category'");
  if (channels.length === 0) {
    return {
      available: false,
      reason:
        'No server structure has been collected yet, so there is no channel list to classify. ' +
        'The collector writes it on startup.',
      status_legend: STATUS_LEGEND,
      caveats: caveats({ dormantDays, minMessages }),
      quality: quality(db, config, ts),
    };
  }

  const inWindow = new Map(
    db
      .all(
        `SELECT channel_id,
                SUM(messages) AS messages,
                COUNT(DISTINCT day_ts) AS active_days,
                MIN(day_ts) AS first_day,
                MAX(day_ts) AS last_day
           FROM message_day WHERE day_ts >= ? GROUP BY channel_id`,
        windowStart,
      )
      .map((r) => [r.channel_id, r]),
  );

  const voiceInWindow = new Map(
    db
      .all(
        `SELECT channel_id, SUM(seconds) AS seconds, COUNT(DISTINCT day_ts) AS active_days
           FROM voice_day WHERE day_ts >= ? GROUP BY channel_id`,
        windowStart,
      )
      .map((r) => [r.channel_id, r]),
  );

  // Ever used, not just used in the window. Two grouped passes, merged, because a
  // channel that went silent two months ago is the case this report exists for.
  const everMsg = new Map(
    db
      .all('SELECT channel_id, MIN(day_ts) AS first_day, MAX(day_ts) AS last_day FROM message_day GROUP BY channel_id')
      .map((r) => [r.channel_id, r]),
  );
  const everVoice = new Map(
    db
      .all('SELECT channel_id, MIN(day_ts) AS first_day, MAX(day_ts) AS last_day FROM voice_day GROUP BY channel_id')
      .map((r) => [r.channel_id, r]),
  );

  // Where the halves start. For window=all there is no window start, and splitting
  // at epoch 0 would put the boundary in 1970 and call every channel "growing".
  const earliestData = minOf(
    ...[...everMsg.values()].map((r) => r.first_day),
    ...[...everVoice.values()].map((r) => r.first_day),
  );
  const serverDataFrom = earliestData === null ? null : dayOf(earliestData);
  // With no activity anywhere, the window still starts where it was asked to. Using
  // "now" made a completely idle server report a one-day coverage window.
  const effectiveStart = Math.max(windowStart, serverDataFrom ?? windowStart);
  const mid = dayOf(effectiveStart + Math.max(DAY, ts - effectiveStart) / 2);

  // Halves of the window, for the trend. Split on the message rows rather than
  // fetching a series per channel: one grouped query instead of N.
  const halves = new Map(
    db
      .all(
        `SELECT channel_id,
                SUM(CASE WHEN day_ts < ? THEN messages ELSE 0 END) AS first_half,
                SUM(CASE WHEN day_ts >= ? THEN messages ELSE 0 END) AS second_half
           FROM message_day WHERE day_ts >= ? GROUP BY channel_id`,
        mid,
        mid,
        effectiveStart,
      )
      .map((r) => [r.channel_id, r]),
  );

  const created = new Map(
    db
      .all(
        `SELECT target_id AS channel_id, MIN(ts) AS created_ts
           FROM structure_change WHERE kind = 'channel_created' GROUP BY target_id`,
      )
      .map((r) => [r.channel_id, r.created_ts]),
  );

  const categories = new Map(
    db
      .all("SELECT channel_id, name FROM channel_meta WHERE type = 'category'")
      .map((r) => [r.channel_id, r.name]),
  );
  const names = new Map(channels.map((c) => [c.channel_id, c.name]));

  // Coverage of the window itself: a channel with no traffic in a window the bot
  // was down for most of is not a channel with no traffic.
  const observedDays = db.get(
    'SELECT COUNT(*) AS n FROM collector_day WHERE day_ts >= ? AND day_ts <= ?',
    effectiveStart,
    today,
  )?.n ?? 0;
  const windowDays = Math.max(1, Math.round((today - effectiveStart) / DAY) + 1);

  const rows = channels.map((ch) => {
    const seen = ch.bot_can_view === 1 ? true : ch.bot_can_view === 0 ? false : null;
    const traffic = inWindow.get(ch.channel_id) ?? null;
    const voice = voiceInWindow.get(ch.channel_id) ?? null;
    const firstEver = minOf(everMsg.get(ch.channel_id)?.first_day, everVoice.get(ch.channel_id)?.first_day);
    const lastEver = maxOf(everMsg.get(ch.channel_id)?.last_day, everVoice.get(ch.channel_id)?.last_day);
    const createdTs = created.get(ch.channel_id) ?? null;
    const deletedTs = ch.deleted_ts ?? null;
    const isTalkable = TALKABLE.has(ch.type);
    const isVoice = ch.type === 'voice' || ch.type === 'stage';

    const messages = traffic?.messages ?? 0;
    const voiceMinutes = Math.round(((voice?.seconds ?? 0) / 60) * 10) / 10;
    // A channel the bot cannot read has no message figure at all. Zero would claim
    // it was watched and found silent, which is the exact confusion this report is
    // supposed to prevent. Traffic that exists anyway is still shown, because that
    // is evidence the flag is stale rather than the channel being invisible.
    const activityKnown = seen === true || messages > 0 || voiceMinutes > 0;

    const half = halves.get(ch.channel_id) ?? null;
    const trend = half
      ? {
          first_half_messages: half.first_half,
          second_half_messages: half.second_half,
          change:
            half.first_half > 0
              ? Number(((half.second_half - half.first_half) / half.first_half).toFixed(3))
              : null,
        }
      : null;

    let stage;
    let stageReason;
    if (deletedTs && deletedTs >= from) {
      stage = 'removed';
      stageReason = lastEver
        ? `deleted on ${isoDate(deletedTs)}, last activity ${isoDate(lastEver)}`
        : `deleted on ${isoDate(deletedTs)} without ever recording activity`;
    } else if (!activityKnown) {
      stage = 'unmeasured';
      stageReason =
        'the bot cannot see this channel, so it has no message or voice figure. Not zero — unknown.';
    } else if (lastEver === null) {
      if (createdTs !== null && createdTs >= from) {
        stage = 'created_unused';
        stageReason = `created ${isoDate(createdTs)} and no message or voice has been recorded since`;
      } else {
        stage = 'never_used';
        stageReason = 'no message or voice has ever been recorded here';
      }
    } else if (lastEver < dormantCutoff) {
      stage = 'dormant';
      stageReason = `no activity since ${isoDate(lastEver)} (${dormantDays}+ days)`;
    } else if (!isTalkable && isVoice) {
      // A voice channel's activity is minutes, not messages, so there is no message
      // trend to compare. Calling it growing or declining on message counts would
      // be reading a measurement that does not exist.
      stage = 'steady';
      stageReason =
        `${voiceMinutes} voice minutes in the window; voice channels are classified on ` +
        'activity and silence, not on a message trend';
    } else if (isTalkable && messages < minMessages) {
      stage = 'low_volume';
      stageReason =
        `${messages} message${messages === 1 ? '' : 's'} in the window, below the ` +
        `${minMessages} needed before a growing/declining call means anything`;
    } else if (createdTs !== null && createdTs >= from) {
      stage = 'new';
      stageReason = `created ${isoDate(createdTs)}, inside the window`;
    } else if (trend && trend.change !== null && trend.change > DORMANT_TREND_THRESHOLD) {
      stage = 'growing';
      stageReason = `messages up ${Math.round(trend.change * 100)}% between the two halves of the window`;
    } else if (trend && trend.change !== null && trend.change < -DORMANT_TREND_THRESHOLD) {
      stage = 'declining';
      stageReason = `messages down ${Math.round(Math.abs(trend.change) * 100)}% between the two halves of the window`;
    } else if (trend && trend.change === null && messages > 0) {
      // All activity landed in the second half: there is nothing to divide by, and
      // calling that "flat" would be wrong.
      stage = 'growing';
      stageReason = 'no messages in the first half of the window, activity only in the second';
    } else {
      stage = 'steady';
      stageReason = 'activity within +/-25% between the two halves of the window';
    }

    return {
      id: ch.channel_id,
      name: ch.name,
      type: ch.type,
      parent: ch.parent_id ? categories.get(ch.parent_id) ?? names.get(ch.parent_id) ?? null : null,
      visible_to_bot: seen,
      activity_known: activityKnown,
      created: createdTs === null ? null : iso(createdTs),
      deleted: deletedTs === null ? null : iso(deletedTs),
      first_activity: firstEver === null ? null : iso(firstEver),
      last_activity: lastEver === null ? null : iso(lastEver),
      days_since_last_activity: lastEver === null ? null : Math.floor((ts - lastEver) / DAY),
      messages: activityKnown ? messages : null,
      voice_minutes: isVoice || voiceMinutes > 0 ? voiceMinutes : null,
      active_days: activityKnown ? (traffic?.active_days ?? 0) : null,
      trend,
      stage,
      stage_reason: stageReason,
    };
  });

  const byStage = {};
  for (const row of rows) byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;

  // Sorted by traffic, known channels first: the point of a capped list is to show
  // the ones with something at stake. Unmeasured channels sort last with a null,
  // never as zero.
  const sorted = [...rows].sort((a, b) => (b.messages ?? -1) - (a.messages ?? -1) || a.name.localeCompare(b.name));
  const returned = sorted.slice(0, limit);

  return {
    available: true,
    window: window.label,
    counts: {
      channels: rows.length,
      talkable: rows.filter((r) => TALKABLE.has(r.type)).length,
      voice: rows.filter((r) => r.type === 'voice' || r.type === 'stage').length,
      visible_to_bot: rows.filter((r) => r.visible_to_bot === true).length,
      invisible_to_bot: rows.filter((r) => r.visible_to_bot === false).length,
      visibility_unknown: rows.filter((r) => r.visible_to_bot === null).length,
    },
    by_stage: byStage,
    // Channel counts, not people: no suppression floor applies to this summary. The
    // rows themselves carry no per-person data at all.
    rows_returned: returned.length,
    rows_truncated: sorted.length > returned.length,
    channels: returned,
    coverage: {
      window_days: windowDays,
      days_with_heartbeat: observedDays,
      note:
        observedDays < windowDays
          ? `The collector recorded only ${observedDays} of ${windowDays} days in this window. ` +
            'Channels with no traffic in the rest were not observed then, and a "dormant" call ' +
            'across that gap is a lower bound, not a finding.'
          : 'The collector ran on every day of this window, so an empty channel was watched and empty.',
    },
    thresholds: {
      dormant_days: dormantDays,
      min_messages_for_trend: minMessages,
      trend_threshold: DORMANT_TREND_THRESHOLD,
    },
    status_legend: STATUS_LEGEND,
    caveats: caveats({ dormantDays, minMessages }),
    quality: quality(db, config, ts),
  };
}

function minOf(...values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? Math.min(...nums) : null;
}

function maxOf(...values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function caveats({ dormantDays, minMessages }) {
  return [
    `A channel needs ${minMessages} messages in the window before a growing/declining call is made; below that it is reported as low_volume.`,
    `dormant means no message or voice for ${dormantDays} days, and requires activity at some point in this collector's history. A channel that was never used is never_used or created_unused instead.`,
    'Messages and voice are counted only in channels the bot can see. unmeasured means exactly that: no figure exists, and it is not a zero.',
    'Creation dates come from recorded structure changes, so a channel that predates install has created: null and is classified from its first observed activity instead.',
    'Channel activity is a lower bound: a day the collector was down contributes nothing, and a partial day is flagged as such everywhere else in this API.',
    'Trend compares the two halves of the requested window by message count. Voice-only channels have no message trend and are classified on silence instead.',
    'Channel names are not unique. Rows carry `id`, so two channels with the same name can be told apart.',
  ];
}

function quality(db, config, ts) {
  return {
    generated_at: iso(ts),
    structure_observed_at: db.getMeta('structure.refreshed_ts') ?? null,
    min_cell: config.privacy.minCell,
  };
}
