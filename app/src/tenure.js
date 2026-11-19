/**
 * Membership spans, and the per-member daily counters they are measured against.
 *
 * A cohort is a set of *membership spans*, not a set of people: someone who leaves
 * and rejoins is a new signup with a new join date, and attributing their old
 * activity to the new cohort would invent retention that did not happen. The
 * backfill, the live member events and the retention query all agree on this one
 * table, which is why it is keyed by (user_hmac, joined_ts).
 *
 * ids are never stored here. Every function takes an already-pseudonymised key,
 * produced by privacy.createIdentity(), so the caller decides whether per-member
 * records exist at all.
 */

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Record a join. Idempotent: the backfill can be re-run without duplicating a
 * tenure, and a live join that races the backfill (member added while it pages)
 * collides on the unique key instead of writing twice.
 *
 * `joinedTs` is Discord's authoritative join time, not "now": during the backfill
 * it is the only thing that reaches back before install.
 *
 * ON CONFLICT DO NOTHING, deliberately. Reopening a closed row on conflict would
 * let a member who left and came back with a second-resolution-identical join
 * time erase the gap, and the gap is the only record that they left at all.
 */
export function recordJoin(db, { key, joinedTs, source = 'live', ts = nowSec() }) {
  if (!key || !Number.isFinite(joinedTs) || joinedTs <= 0) return false;
  const result = db.run(
    `INSERT INTO member_tenure(user_hmac, joined_ts, left_ts, source, recorded_ts)
     VALUES(?,?,NULL,?,?)
     ON CONFLICT(user_hmac, joined_ts) DO NOTHING`,
    key,
    Math.floor(joinedTs),
    source,
    ts,
  );
  return Number(result?.changes ?? 0) > 0;
}

/**
 * Close the open tenure(s) for a member.
 *
 * All of them, not one: a missed leave followed by a rejoin can leave two rows
 * open, and leaving one open would make a departed member look like a current one
 * for churn purposes. An already-closed tenure is never reopened by this, so a
 * stray GUILD_MEMBER_REMOVE cannot rewrite history.
 */
export function recordLeave(db, { key, ts = nowSec() }) {
  if (!key) return false;
  const out = db.run(
    'UPDATE member_tenure SET left_ts = ? WHERE user_hmac = ? AND left_ts IS NULL',
    Math.floor(ts),
    key,
  );
  return Number(out?.changes ?? 0) > 0;
}

/**
 * Add message counts to a member's day row.
 *
 * `delta` is what has not been persisted yet, matching the collectors' flusher
 * convention: a restart re-counts from zero, so the stored value is the previous
 * value plus the delta rather than the delta itself. voice_s is left untouched on
 * conflict so the two collectors can write the same day row without clobbering
 * each other.
 */
export function addMemberDayMessages(db, { key, dayTs, delta }) {
  if (!key || !(delta > 0)) return;
  const day = Math.floor(dayTs);
  const prev = db.get('SELECT messages FROM member_day WHERE day_ts = ? AND user_hmac = ?', day, key);
  db.run(
    `INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,?,0)
     ON CONFLICT(day_ts, user_hmac) DO UPDATE SET messages = excluded.messages`,
    day,
    key,
    (prev?.messages ?? 0) + delta,
  );
}

/** Voice counterpart of addMemberDayMessages; messages is left untouched. */
export function addMemberDayVoice(db, { key, dayTs, delta }) {
  if (!key || !(delta > 0)) return;
  const day = Math.floor(dayTs);
  const prev = db.get('SELECT voice_s FROM member_day WHERE day_ts = ? AND user_hmac = ?', day, key);
  db.run(
    `INSERT INTO member_day(day_ts, user_hmac, messages, voice_s) VALUES(?,?,0,?)
     ON CONFLICT(day_ts, user_hmac) DO UPDATE SET voice_s = excluded.voice_s`,
    day,
    key,
    (prev?.voice_s ?? 0) + delta,
  );
}
