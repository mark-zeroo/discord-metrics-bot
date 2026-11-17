"""
title: Discord Server Metrics
author: discord-metrics-bot contributors
version: 1.2.5
required_open_webui_version: 0.5.0
license: MIT
description: Read-only, aggregate-only access to Discord server metrics (members, messages, voice, growth, engagement concentration, tagged events, server structure) via the local discord-metrics API.

Why this shape:

* The model never talks to Discord. It talks to a small read-only API that
  already holds the numbers, so no Discord bot token ever enters Open WebUI.
* Every tool here maps to one GET on a fixed path with a whitelisted query
  string. There is no free-form URL, no SQL, no write verb, nothing to inject
  into. The only model-controlled inputs are an enum window, an enum bucket,
  and two small integers.
* Responses are aggregates. No usernames, no user IDs, no message text, no
  per-channel drill-down that could single out a member.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# Canonical set, mirroring src/time.js exactly. These are the only tokens the API
# accepts; anything else is a 400 from parseWindow before a query ever runs.
WINDOWS = ("1d", "7d", "30d", "90d", "365d", "all")

# Tolerated spellings. This used to be a hard enum of "24h" on the tool side and
# "1d" on the API side, so the sets only overlapped at 7d/30d/90d/all — "24h"
# 400'd at the API and "1d" was rejected locally, leaving no way to ask for a
# single day. Normalize instead of failing: a model reaching for "24h" is
# making a reasonable request.
WINDOW_ALIASES = {
    "24h": "1d",
    "today": "1d",
    "1w": "7d",
    "week": "7d",
    "1m": "30d",
    "month": "30d",
    "3m": "90d",
    "quarter": "90d",
    "1y": "365d",
    "year": "365d",
}

BUCKETS = ("hour", "day", "week", "month")

# Ordered from finest to coarsest: used to compress an oversized series.
_BUCKET_LADDER = ("hour", "day", "week", "month")


def normalize_window(window: str) -> Optional[str]:
    """Map a requested window onto the API's canonical token, or None if unknown."""
    key = (window or "").strip().lower()
    resolved = WINDOW_ALIASES.get(key, key)
    return resolved if resolved in WINDOWS else None


def normalize_bucket(bucket: str) -> Optional[str]:
    key = (bucket or "").strip().lower()
    return key if key in BUCKETS else None


class Tools:
    class Valves(BaseModel):
        """Connection settings. The token is per-deployment; issue one per consumer."""

        API_URL: str = Field(
            # The tool executes inside the openwebui container, so 127.0.0.1 would
            # point at openwebui itself — nothing listens on :8283 there and every
            # call returns ECONNREFUSED. Compose service name is the correct
            # address between containers on the shared default network.
            default="http://metrics:8283",
            description=(
                "Base URL of the discord-metrics API. Use http://metrics:8283 when "
                "running beside it in Docker; http://127.0.0.1:8283 only when the "
                "tool runs on the host outside a container."
            ),
        )
        API_TOKEN: str = Field(
            default="",
            description="Bearer token from `npm run token -- issue`. Stored hashed server-side.",
            json_schema_extra={"input": {"type": "password"}},
        )
        TIMEOUT_SECONDS: int = Field(
            default=10, ge=1, le=30, description="Per-request timeout."
        )
        MAX_PAYLOAD_BYTES: int = Field(
            # A year of daily buckets is ~26 kB — roughly 7k tokens for one tool
            # call, which crowds out the conversation. Rather than truncating the
            # series (which drops the older half of the very period being asked
            # about), the tool re-requests a coarser bucket and says so.
            default=12000,
            ge=2000,
            le=60000,
            description="If a series response exceeds this size, re-request it with a coarser bucket.",
        )
        MAX_SERIES_POINTS: int = Field(
            # 60 was too small to survive ordinary questions: "7d by hour" is 168
            # points and "365d by day" is 365, so a default of 60 silently answered
            # both with the most recent third of the window. The API already caps
            # series at a few hundred points, so trimming only needs to catch the
            # rare oversized case, not every daily series.
            default=400,
            ge=5,
            le=750,
            description=(
                "Trim long series to the most recent N points to protect the context window. "
                "Aggregate totals are unaffected by trimming."
            ),
        )

    def __init__(self) -> None:
        self.valves = self.Valves()

    # ------------------------------------------------------------------ http

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Single choke point for HTTP. Fixed paths only, GET only, token from valves."""
        if not self.valves.API_TOKEN:
            return {"error": "api_token_not_configured"}

        url = self.valves.API_URL.rstrip("/") + path
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            url = f"{url}?{urllib.parse.urlencode(clean)}"

        req = urllib.request.Request(
            url,
            method="GET",
            headers={
                "Authorization": f"Bearer {self.valves.API_TOKEN}",
                "Accept": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=self.valves.TIMEOUT_SECONDS) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("detail", "")
            except Exception:
                pass
            out: Dict[str, Any] = {"error": f"http_{exc.code}", "detail": detail}
            # A throttle without a retry hint is unactionable: the model can only
            # report "it failed". The API sends retry-after on 429, so pass the
            # seconds through and say what the caller should do about it.
            retry_after = exc.headers.get("retry-after") if exc.headers else None
            if exc.code == 429:
                out["retry_after_seconds"] = int(retry_after) if (retry_after or "").isdigit() else None
                out["hint"] = "The metrics API is rate limiting this token. Wait, then retry once; do not loop."
            elif exc.code == 401:
                out["hint"] = "The API rejected the token. An operator must issue a new one with scripts/issue-token.mjs."
            return out
        except urllib.error.URLError as exc:
            return {"error": "api_unreachable", "detail": str(exc.reason)}
        except json.JSONDecodeError:
            return {"error": "bad_response"}
        except Exception:
            # Never echo exception text that could contain the URL or token.
            return {"error": "request_failed"}

    def _trim(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Keep long series inside the context budget without making the payload lie.

        When points are dropped, series_meta has to follow, otherwise it reports the
        original bucket count next to a shorter array and the model has two
        contradictory descriptions of the same series.
        """
        series = payload.get("series")
        if isinstance(series, list) and len(series) > self.valves.MAX_SERIES_POINTS:
            keep = self.valves.MAX_SERIES_POINTS
            dropped = len(series) - keep
            payload["series"] = series[-keep:]
            payload["series_truncated_to_last"] = keep
            payload["series_dropped_points"] = dropped
            meta = payload.get("series_meta")
            if isinstance(meta, dict):
                meta["returned_buckets"] = keep
                meta["truncated"] = True
                meta["dropped_buckets"] = dropped
                meta["note"] = (
                    "Series trimmed to the most recent buckets to fit the context window. "
                    "totals, tenure and caveats still describe the full requested window."
                )
        return payload

    def _fit(self, path: str, params: Dict[str, Any], bucket: str) -> Dict[str, Any]:
        """Fetch a series, coarsening the bucket if the payload would be too large.

        Daily buckets over a year are ~26 kB of JSON. Dropping points would answer
        "how did we grow this year" with four months of data, so coarsening is the
        honest compression: same window, fewer, wider buckets. The change is
        recorded in series_coarsened_from so the model never reports a coarser
        series as if it were the granularity it asked for.
        """
        payload = self._get(path, params)
        if "error" in payload or bucket not in _BUCKET_LADDER:
            return payload

        for coarser in _BUCKET_LADDER[_BUCKET_LADDER.index(bucket) + 1 :]:
            if len(json.dumps(payload, separators=(",", ":")).encode()) <= self.valves.MAX_PAYLOAD_BYTES:
                break
            trial = self._get(path, {**params, "bucket": coarser})
            if "error" in trial:
                break
            trial["series_coarsened_from"] = bucket
            trial["note"] = (
                f"A {bucket} series for this window was too large to return; this is the same "
                f"window at {coarser} granularity. totals and caveats are unchanged."
            )
            payload = trial
        return payload

    # --------------------------------------------------------------- tools

    def get_server_summary(self, window: str = "30d") -> str:
        """
        Headline totals for this Discord server: member count, online now, boosts,
        messages sent, distinct posters, voice hours, and joins/leaves for the period.
        Use this first for any general "how is the server doing" question.

        :param window: 1d (a.k.a. 24h), 7d, 30d, 90d, 365d, or all. Default 30d.
        :return: JSON object with guild, totals, and caveats.
        """
        window = normalize_window(window)
        if window is None:
            return json.dumps({"error": "invalid_window", "allowed": list(WINDOWS)})
        return json.dumps(self._get("/v1/summary", {"window": window}), separators=(",", ":"))

    def get_activity_series(self, window: str = "30d", bucket: str = "day", top: int = 5) -> str:
        """
        Message and voice activity over time, plus the busiest channels by message count.
        Use for trends, seasonality, event impact, and "when is the server active" questions.
        Hours are UTC.

        :param window: 1d (a.k.a. 24h), 7d, 30d, 90d, 365d, or all. Default 30d.
        :param bucket: hour, day, week, or month. Use hour only with 1d or 7d.
        :param top: How many top channels to include. Clamped to 1-10 here rather than rejected,
            so any integer is safe to pass.
        :return: JSON object with series and top_channels.
        """
        window = normalize_window(window)
        if window is None:
            return json.dumps({"error": "invalid_window", "allowed": list(WINDOWS)})
        bucket = normalize_bucket(bucket)
        if bucket is None:
            return json.dumps({"error": "invalid_bucket", "allowed": list(BUCKETS)})
        if bucket == "hour" and window not in ("1d", "7d"):
            return json.dumps({"error": "bucket_too_fine", "detail": "hour bucket only with 1d or 7d"})
        top = max(1, min(int(top), 10))
        payload = self._fit("/v1/activity", {"window": window, "bucket": bucket, "top": top}, bucket)
        return json.dumps(self._trim(payload), separators=(",", ":"))

    def get_growth_and_tenure(self, window: str = "90d", bucket: str = "day") -> str:
        """
        Joins, leaves, net growth, and how long current members have been around.
        Use for retention, churn, and "are we growing" questions.

        Read totals for any "how many joined/left" question: they are already summed
        over the window. Use the series for shape (a spike, a slump), not for arithmetic.

        :param window: 1d (a.k.a. 24h), 7d, 30d, 90d, 365d, or all.
        :param bucket: day (default), week, or month. Long windows auto-coarsen if the
            daily series would be too large; check series_coarsened_from.
        :return: JSON object with series, totals, series_meta and a tenure breakdown.
        """
        window = normalize_window(window)
        if window is None:
            return json.dumps({"error": "invalid_window", "allowed": list(WINDOWS)})
        bucket = normalize_bucket(bucket) or "day"
        if bucket == "hour" and window not in ("1d", "7d"):
            return json.dumps({"error": "bucket_too_fine", "detail": "hour bucket only with 1d or 7d"})
        payload = self._fit("/v1/growth", {"window": window, "bucket": bucket}, bucket)
        return json.dumps(self._trim(payload), separators=(",", ":"))

    def get_voice_activity(self, window: str = "30d", bucket: str = "day", top: int = 5) -> str:
        """
        Voice minutes over time and the busiest voice channels. Voice is counted in
        member-seconds in non-AFK channels. A member alone in a channel still counts,
        and by default so does a muted one (VOICE_COUNT_MODE=present), which matches
        how a phone-based group sits in a voice lobby while playing on a phone; the
        collector
        only requires an unmuted member under VOICE_COUNT_MODE=unmuted. Use for
        "are people actually sitting in calls" rather than text-only activity.

        :param window: 1d (a.k.a. 24h), 7d, 30d, 90d, 365d, or all. Default 30d.
        :param bucket: hour, day, week, or month. Use hour only with 1d or 7d.
        :param top: How many top channels to include. Clamped to 1-10 here rather than rejected,
            so any integer is safe to pass.
        :return: JSON object with series and top_channels.
        """
        window = normalize_window(window)
        if window is None:
            return json.dumps({"error": "invalid_window", "allowed": list(WINDOWS)})
        bucket = normalize_bucket(bucket)
        if bucket is None:
            return json.dumps({"error": "invalid_bucket", "allowed": list(BUCKETS)})
        if bucket == "hour" and window not in ("1d", "7d"):
            return json.dumps({"error": "bucket_too_fine", "detail": "hour bucket only with 1d or 7d"})
        top = max(1, min(int(top), 10))
        payload = self._fit("/v1/voice", {"window": window, "bucket": bucket, "top": top}, bucket)
        return json.dumps(self._trim(payload), separators=(",", ":"))

    def get_events(self) -> str:
        """
        Discord scheduled events and their observed turnout. Only reflects events created
        in Discord; community tournaments and game nights are usually not scheduled
        events, so prefer get_event_tags for those.

        :return: JSON object with an events list.
        """
        return json.dumps(self._get("/v1/events"), separators=(",", ":"))

    def get_event_tags(self, limit: int = 10) -> str:
        """
        Operator-declared event windows (tournaments, game nights, prize nights) with the
        activity measured inside each window and an uplift figure against the trailing
        trailing per-day baseline (EVENT_BASELINE_DAYS, default 28). Use this to answer
        "did the tournament move the needle"
        and to compare events against each other.

        :param limit: How many most-recent tags to return (1-50).
        :return: JSON object with tags, each holding during, baseline, and uplift.
        """
        limit = max(1, min(int(limit), 50))
        return json.dumps(self._get("/v1/tags", {"limit": limit}), separators=(",", ":"))

    def get_engagement_concentration(self, window: str = "30d") -> str:
        """
        How unevenly activity is spread across members: how many people produce 80% of
        messages, the share from the top 10%, a Gini coefficient, a distribution of
        members by message volume, and the active-to-lurker ratio. Use this to tell a
        healthy community apart from a handful of regulars and a lot of lurkers.

        Requires PER_MEMBER_COUNTERS=hmac on the API; returns available=false with a
        reason otherwise. The window is capped to hourly retention (default 90 days).

        :param window: 1d (a.k.a. 24h), 7d, 30d, 90d, 365d, or all. Default 30d.
        :return: JSON object with concentration, lurkers, and caveats.
        """
        window = normalize_window(window)
        if window is None:
            return json.dumps({"error": "invalid_window", "allowed": list(WINDOWS)})
        return json.dumps(self._get("/v1/engagement", {"window": window}), separators=(",", ":"))

    def get_member_presence(self) -> str:
        """
        Current online count, total members, and the online ratio. A point-in-time snapshot,
        not a history. Use when asked who is around right now.

        :return: JSON object with a single snapshot.
        """
        return json.dumps(self._get("/v1/presence"), separators=(",", ":"))

    def get_server_structure(self, window: str = "30d", detail: str = "summary") -> str:
        """
        How the server is configured: channels grouped by category, roles and their
        permissions, guild settings, and — most importantly — which channels the bot
        can actually see. Use this to explain why an activity number looks the way it
        does, to find channels nobody uses, or to audit role permissions.

        The coverage block answers "is this channel quiet or am I blind?", which is the
        right question to ask before believing any zero. A channel the bot cannot see is
        excluded from every message and voice total, so activity is a lower bound.

        Read coverage in this order:
          invisible_to_bot / invisible_share — how big the gap is;
          invisible_channels — which channels, capped at 50 names, with
            invisible_channels_truncated telling you when the list is a sample;
          visibility_contradictions — channels flagged invisible that nonetheless have
            collected traffic. Do not call these a measurement gap or ask for View
            Channel: they are already being measured, so the flag is stale or wrong.

        Categories carry activity_known. When it is false, no channel in that category is
        visible and messages is null — nothing was measured, which is not the same as a
        quiet category reporting 0. A category's messages counts visible children only; any
        traffic from children it cannot currently see is in messages_from_invisible (also null
        when the category has nothing visible, since that traffic cannot be known), and
        unused_voice_channels counts visible voice channels with no voice time (a voice
        channel is never "empty" in the message sense, so it is not in empty_channels).
        A category with no text channels at all (a voice-only category) reports messages: 0
        with activity_known: true — zero is a fact there, not a missing measurement.

        The categories array ends with a "(no category)" row when any channel belongs to no
        category, which includes threads (their parent is a channel, not a category). It is
        not a Discord category; it exists so the rollup accounts for every channel. The
        per-category channels and empty_channels therefore sum to counts.channels and
        activity.channels_with_no_traffic, and unused_voice_channels sums to
        voice_channels_visible minus voice_channels_used — if they do not, that is a bug
        worth reporting, not a rounding gap.
        voice_channels_visible counts stage channels too, since a stage carries voice;
        counts.by_type separates voice from stage.

        Channel names are not unique (a text channel and a voice channel can share one), so
        any name that repeats is returned as "name (type, category)" — quote it verbatim when
        telling the user which channel to fix. The invisible list is ordered by how actionable
        a grant would be: channels with traffic first, then channels in mostly-visible
        categories, then channels whose parent category is unknown (uncategorised or
        dangling), with wholly-invisible categories (Archive) last, so a capped list does not
        bury the channels someone is actively fixing. In detail=full, a channel the bot cannot
        read reports messages: null rather than 0 — 0 would claim it was watched and silent. activity.channels_with_traffic counts every
        channel with messages, including ones now flagged invisible; the visible-only figure
        is visible_channels_with_traffic and is the one that adds up against
        talkable_channels_visible. Each busiest row carries visible_to_bot, so a channel
        that is also a coverage contradiction is not quoted as if it were a normal one.

        :param window: 1d, 7d, 30d, 90d, 365d, or all — the period used to decide which
            channels count as active. Default 30d.
        :param detail: "summary" (counts, coverage, permission audit, per-category
            rollups, notable channels) or "full" (adds every channel and every role,
            roughly 10x larger). Default summary.
        :return: JSON object with counts, coverage (including visibility contradictions
            and truncation flags), guild settings, permission_audit, activity, categories,
            and recent structural changes.
        """
        window = normalize_window(window)
        if window is None:
            return json.dumps({"error": "invalid_window", "allowed": list(WINDOWS)})
        detail = (detail or "summary").strip().lower()
        if detail not in ("summary", "full"):
            return json.dumps({"error": "invalid_detail", "allowed": ["summary", "full"]})
        return json.dumps(
            self._get("/v1/structure", {"window": window, "detail": detail}),
            separators=(",", ":"),
        )

    def get_data_quality(self) -> str:
        """
        How trustworthy the numbers are: coverage start, uptime of the collector, any
        partial days caused by restarts, and how many channels the bot can actually see.
        Call this when the user questions the data or before making a strong claim about a
        trend — especially before believing that something is zero.

        :return: JSON object describing coverage and gaps.
        """
        return json.dumps(self._get("/v1/quality"), separators=(",", ":"))
