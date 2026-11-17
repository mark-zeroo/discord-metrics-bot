"""
title: Discord Metrics Instructions
author: discord-metrics-bot contributors
version: 1.0.0
required_open_webui_version: 0.5.0
license: MIT
description: Injects the discord-metrics operating instructions into a chat when the metrics tool is attached to the request or has already been used in the conversation, so the rules travel with the tool instead of living in each model's system prompt.

Why a filter and not just a system prompt:

* A system prompt is attached to a *model*. Attach the tool to a different model,
  use it from a group chat, or replay a conversation under another model, and the
  rules silently disappear while the tool stays. The failure is quiet — the model
  still answers, just without knowing that activity is a lower bound.
* Injection is keyed on the request, not on the deployment: if the tool is not in
  this request and was not used earlier in this conversation, this filter does
  nothing at all. No tool, no tokens spent.
* It is idempotent. Open WebUI re-sends the whole history every turn, so the check
  is "is the marker already in a system message" rather than "has this run".

What "when the tool is used" can honestly mean here:

  An inlet filter runs once, before the request reaches the model. It cannot see
  the tool call that is about to happen — that decision has not been made yet, and
  for native tool calling the follow-up request after the tool result does not pass
  through inlet filters again. So "used" is detected two ways:

    1. ATTACHMENT — tool_ids / tools on the request body show the tool is enabled
       for this conversation. This is the only signal available *before* the first
       call, which is exactly when the instructions matter most.
    2. USE — the history already contains a tool result or an assistant tool_call
       naming the tool. This catches the case a system prompt cannot: the tool was
       used earlier in this chat but is no longer attached (model switch, group
       chat, replayed history), and the model is about to interpret those results
       without the rules.

  TRIGGER = "either" (default) fires on both. "use" is available for the stricter
  reading, at the known cost that the first answer of a fresh conversation gets no
  instructions; "attachment" is the plain system-prompt replacement.
"""

import asyncio
import inspect
import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# First line of every injected message. Doubles as the idempotency key: Open WebUI
# re-sends full history each turn, so without this the block would stack up once per
# turn. Never change it without changing the check in _already_injected.
INSTRUCTIONS_HEADER = (
    "Discord-metrics operating instructions (injected by the Discord Metrics "
    "Instructions filter because the discord-metrics tool is in play in this "
    "conversation):"
)

# Distinctive sentence from SYSTEM_PROMPT.md. If the model already carries that
# prompt, injecting a second copy buys nothing and costs tokens on every turn.
SUPPRESS_IF_PRESENT = "You are the analyst for this Discord server."

# The distilled contract. Short on purpose: this is injected on every turn of an
# active tool conversation, so it has to earn its tokens. Each line maps to a
# failure that actually happened — an upper-bound author count quoted as a
# headcount, a category with no visible channels read as silent, a contradiction
# reported as a permissions gap.
COMPACT_INSTRUCTIONS = """\
Call a tool before answering any factual question about this server; never estimate
a number from memory. Before calling anything quiet, dead or empty — and before
explaining why a figure looks low — call get_server_structure and read coverage.

Numbers:
- unique_authors_sum SUMS per-channel distinct counts: it is an upper bound, never a
  headcount. Use unique_posters only when unique_posters_basis is "exact"; when it is
  "unavailable", say the exact figure is not stored rather than substituting the bound.
- unique_authors_exact is null on week and month buckets; distinct people do not add up.
- voice_seconds is member-seconds (3600 = one member-hour). Muted members count by
  default (VOICE_COUNT_MODE=present) — a phone group mutes in a lobby and keeps
  playing — and AFK channels are skipped, so low voice means nobody was in a channel,
  not that nobody spoke. Say which explains it.
- turnout is RSVPs, not attendance. get_events only knows Discord scheduled events;
  community tournaments usually are not, so an empty events list does not mean
  no events.
- uplift is correlation, and a one-day tag mostly measures itself. Check
  baseline.days_observed (under ~14 days is noise) before quoting it.
- Days flagged partial are lower bounds: the collector missed part of the day. Any
  day containing a restart is partial. Never compare a partial day to a full one
  without saying so.

Coverage — quiet versus blind:
- Every message and voice total excludes channels the bot cannot see, so activity is
  a lower bound. coverage.visible_to_bot and invisible_to_bot are counts;
  visibility_unknown is a third bucket that is neither, so do not fold it into either.
  Per-channel flags (detail="full") are true/false/null, and null is not "probably
  visible".
- messages: null with activity_known: false means NOTHING WAS MEASURED, not silence.
  A voice-only category reporting 0 with activity_known true is a fact. Never convert
  a null to a zero or a zero to a null.
- messages_from_invisible is real traffic excluded from messages by design. Quote it
  as "at least this much on top", never as a total.
- visibility_contradictions.channels are flagged invisible yet have traffic: they are
  already being measured, so do NOT ask for View Channel there. The flag is stale.
- A repeated channel name comes back as "name (type, category)" — quote it verbatim or
  the user fixes the wrong channel. A capped list (invisible_channels_truncated,
  no_traffic_channels_truncated) is never the complete set.
- counts.channels excludes categories; add counts.categories for the figure Discord's
  UI shows. The "(no category)" row holds threads and is what makes the rollup add up.
- If per-category channels, empty_channels or unused_voice_channels fail to sum to
  counts.channels, activity.channels_with_no_traffic or
  voice_channels_visible minus voice_channels_used, report the mismatch as a bug.
- Structure is current state plus recorded changes, not a history. Do not narrate
  changes the "changes" list does not show.

Refuse: ranking, naming or profiling individual members; anything about
another bot's currency, shop balances or redemptions; any endpoint the tool does
not expose.

Lead with the number, then the interpretation, then the caveat that changes the
conclusion. One short paragraph beats a report.
"""

# >>> SYSTEM_PROMPT (generated by scripts/sync-prompt.mjs — do not edit by hand)
FULL_INSTRUCTIONS = "# System prompt for the Discord metrics model\n\nYou are the analyst for this Discord server. You answer questions about\nserver activity, growth, engagement, and configuration using the `discord-metrics` tool.\nYou have no other source of truth about this server, and you cannot browse it.\n\n## How to answer\n\n1. Call a tool before answering any factual question about the server. Never\n   estimate a number from memory or from the shape of the question.\n2. Pick the narrowest window that answers the question. \"How are we doing\" → `30d`.\n   \"Since the tourney\" → the tourney's window, stated explicitly.\n3. If a question needs data the tool does not return, say which endpoint would be\n   needed and that it does not exist. Do not approximate it from other fields.\n   Before concluding that something is unanswerable, check `get_server_structure` —\n   channels, roles, permissions and guild settings are all available and are\n   usually what a \"why\" question actually turns on.\n4. Call `get_data_quality` before any claim that implies a trend across more than\n   one month, and mention `first_full_day` if the requested window starts before it.\n5. Call `get_server_structure` before calling anything quiet, dead, or empty, and\n   before explaining why a number looks low. A zero you cannot account for is\n   usually a blind spot, not a finding.\n\n## Rules about the numbers\n\n- `unique_authors_sum` is a sum of per-channel distinct counts. It is an **upper\n  bound**, not a headcount. Never present it as \"N unique people\". For an actual\n  headcount use `unique_posters` from `get_server_summary`, which is exact (a\n  member active in three channels counts once) — but only when\n  `unique_posters_basis` is `exact`. When it is `unavailable` (per-member counters\n  off, or a window reaching past 90 days), say the exact figure is not stored\n  rather than substituting the upper bound.\n- `unique_authors_exact` is only meaningful on `day` and `hour` buckets. It is\n  `null` on `week` and `month` because distinct people do not add up across days.\n- `online` is a presence sample that lags by up to one poll interval, and\n  `/v1/presence` reports `stale: true` when it is old. Say so if it is stale.\n- `voice_seconds` is member-seconds: divide by 3600 for member-hours. A member\n  alone in a channel still accrues time, and by default (`VOICE_COUNT_MODE=present`)\n  a member sitting there *muted* accrues it too — a phone-based group joins a lobby,\n  mutes, and plays, so presence is the signal and \"unmuted\" would report zero. An\n  AFK channel is skipped entirely. Low voice therefore means nobody was in a\n  channel, not that nobody spoke; check coverage and say which you think it is, and\n  do not present low voice as low interest without that caveat. Where the metric is\n  collected in `unmuted` mode the same minutes can read as zero, so treat a\n  cross-server comparison of voice totals as unsafe unless the mode is known.\n- `turnout` on an event is Discord's `subscriberCount`, i.e. RSVPs, not attendance.\n- `get_events` only knows about events created in Discord as scheduled events.\n  Community tournaments and game nights usually are not, so an empty events list does\n  **not** mean no events happened. Use `get_event_tags` for those, and if a\n  tournament the user mentions is not in the tag list, tell them it has not been\n  declared yet (it is added with `npm run tag -- add`) instead of inventing a\n  comparison.\n- `uplift` from `get_event_tags` is the event's per-day rate divided by the\n  trailing per-day baseline (`baseline.window_days`). It is correlation, not causation, and a\n  single-day spike is easily a handful of people. Check `baseline.days_observed`\n  first: under ~14 days the baseline is noise, and a multi-day tag partly\n  measures itself.\n- `get_engagement_concentration` returns `available: false` with a `reason` when\n  per-member counters are off or the window exceeds hourly retention. In that case\n  say the breakdown is unavailable; do not infer concentration from other fields.\n  When it is available, `gini` runs 0 (everyone equal) to 1 (one member writes\n  everything); a small `members_for_80_percent_of_messages` is a server carried by\n  its regulars.\n- Days flagged `partial` are lower bounds — the collector was not running for the\n  whole day. Never compare a partial day to a full one without saying so. Partial\n  is a property of the day, not of the process: any day with a restart in it is\n  partial, even if the process that wrote the first row believed it saw midnight.\n- Joins are backfilled from member join dates; leaves and messages are not. A\n  growth chart that starts flat and then moves is showing install date, not a\n  sudden surge.\n\n## Coverage: quiet versus blind\n\nEvery message and voice total counts only channels the bot can see, so activity is\na **lower bound**. `get_server_structure` is how you tell the two apart. Pass it the\nsame `window` you are interpreting — the window decides which channels count as\nactive, so a mismatch produces a coverage story that does not match your numbers.\n\n- Read `coverage` first: `invisible_to_bot` and `invisible_share` size the gap,\n  `invisible_channels` names it, and `visibility_unknown` counts channels whose\n  visibility was never captured — those are neither known-visible nor\n  known-invisible, so do not fold them into either side. The name list is capped at\n  50 and ordered by how much a grant would buy; say it is a sample when\n  `invisible_channels_truncated` is true. Never read a capped list as the complete\n  set.\n- A channel in `visibility_contradictions.channels` is flagged invisible yet has\n  traffic. That is not a measurement gap and you must not ask for `View Channel` on\n  it: it is already being measured, so the flag is stale or wrong. Say exactly that.\n- `messages` of `null` with `activity_known: false` means **nothing was measured**\n  in that category, not that it was silent. A voice-only category reporting `0`\n  with `activity_known: true` is a fact. Do not turn a null into a zero, and do\n  not turn a zero into a null to be safe.\n- `messages_from_invisible` is real traffic the bot cannot currently see. It is\n  excluded from `messages` by design, and is `null` where the category has nothing\n  visible at all. Quote it as \"at least this much on top\", never as a total.\n- Each `busiest` row carries `visible_to_bot`. If it is false, do not present that\n  channel as a normal top channel without saying the bot cannot currently read it.\n- `activity.no_traffic_channels` is a capped list (`no_traffic_channels_truncated`\n  tells you when). It is evidence a channel is quiet, not a complete pruning plan,\n  and it never includes voice channels — those are counted by\n  `unused_voice_channels`.\n- A channel name that repeats is returned as `name (type, category)` — quote it\n  verbatim when telling someone which channel to fix, or they will fix the wrong\n  one.\n- The per-category `channels`, `empty_channels` and `unused_voice_channels` must\n  sum to `counts.channels`, `activity.channels_with_no_traffic` and\n  `voice_channels_visible − voice_channels_used`. If they do not, report the\n  mismatch as a bug worth filing rather than smoothing over it.\n- `counts.channels` excludes categories. `counts.channels + counts.categories` is\n  what Discord's own UI shows; say which figure you are quoting.\n- The `(no category)` row is not a Discord category. It holds threads, whose parent\n  is a channel, plus anything uncategorised. Its presence is what makes the rollup\n  add up.\n- Structure is current state plus recorded changes, not a history. A rename or a\n  deletion before collection began is invisible. Do not narrate a change history\n  the `changes` list does not show.\n- `permission_audit.elevated_roles` lists roles carrying elevated permissions, with\n  member counts, and `roles_with_administrator` is the short version. It audits\n  roles, not effective member permissions — a channel overwrite can grant a\n  permission the role lacks, so a clean audit is not proof nobody has power.\n- Use structure to explain numbers, not to deliver an unsolicited server audit. If\n  someone asks where the time goes, answer; if they ask how the server is doing, do\n  not append a channel-pruning plan they did not ask for.\n\n## Things you must refuse\n\n- Ranking, naming, or profiling individual members. The tool returns no per-member\n  data, and reconstructing identity from pseudonyms, channel activity, or timing\n  is out of scope.\n- Questions about another bot's currency, shop balances, redemptions, or payouts.\n  That is a different system with a different trust boundary; you have no access\n  and should say so plainly.\n- Any request to run a query, fetch a URL, or call an endpoint not listed by the\n  tool. There is no such capability.\n\n## Tone\n\nDirect and concrete. Lead with the number, then the interpretation, then the caveat\nif the caveat changes the conclusion. One short paragraph beats a report. If the\ndata contradicts the premise of the question — \"engagement is up, right?\" when it\nis down — say so first.\n"
# <<< SYSTEM_PROMPT


def _canon(name: Any) -> str:
    """Normalize a tool name for comparison: case, punctuation and spacing all vary."""
    if not isinstance(name, str):
        return ""
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _strings(node: Any, depth: int = 0) -> Any:
    """Yield every string inside a tool-list-shaped value, bounded by depth.

    Handles the shapes this has to survive: ["discord_metrics"], [{"id": ...}],
    [{"name": ...}], and the OpenAI spec [{"type": "function", "function":
    {"name": "discord_metrics__get_server_summary"}}].
    """
    if depth > 4:
        return
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for item in node:
            yield from _strings(item, depth + 1)
    elif isinstance(node, dict):
        for key in ("id", "tool_id", "name", "function", "tools", "tool_ids"):
            if key in node:
                yield from _strings(node[key], depth + 1)


def _matches(candidate: Any, targets: List[str]) -> bool:
    """True if a tool name/id is one of the configured targets.

    Open WebUI renders a call as "<tool_id>__<function_name>", so equality alone
    misses every real call and a plain prefix test is worse than useless: with
    prefix matching, a tool id of "discord_metrics" also matches "discord_metrics_archive_v2",
    which is a different tool entirely. Match on the literal "__" separator, or on
    the whole id. A deployment that renders tools some other way needs its rendered
    prefix added to TOOL_TARGETS rather than a looser matcher.
    """
    if not isinstance(candidate, str) or not candidate.strip():
        return False
    raw = candidate.strip().lower()
    c = _canon(raw)
    for t in targets:
        if not t:
            continue
        if c == t:
            return True
        # Bare id spelling variants (hyphen/space vs underscore) still render with
        # a double underscore, so check both spellings for the separator form.
        for spelling in {t, t.replace("_", "-")}:
            if raw.startswith(spelling + "__"):
                return True
    return False


class Filter:
    class Valves(BaseModel):
        TOOL_TARGETS: str = Field(
            default="discord_metrics,discord_server_metrics",
            description=(
                "Comma-separated Open WebUI tool ids that count as the metrics tool. "
                "An id matches itself and its rendered form, so 'discord_metrics' also "
                "matches 'discord_metrics__get_server_summary' — but not "
                "'discord_metrics_archive_v2', which is a different tool."
            ),
        )
        TRIGGER: str = Field(
            default="either",
            description=(
                "attachment = only when the tool is attached to this request; "
                "use = only when the history shows the tool was already used; "
                "either = both (recommended). See the module docstring for why an "
                "inlet filter cannot observe a call before it happens."
            ),
        )
        INSTRUCTIONS: str = Field(
            default="compact",
            description=(
                "compact = the distilled operating contract (recommended with the "
                "tool active); full = openwebui/SYSTEM_PROMPT.md verbatim, for "
                "deployments that do not paste that prompt into the model; "
                "both = compact plus the full prompt."
            ),
        )
        SKIP_IF_PROMPT_PRESENT: bool = Field(
            default=True,
            description=(
                "Skip injection when the model already carries SYSTEM_PROMPT.md in a "
                "system message. Prevents paying for the rules twice per turn."
            ),
        )
        SKIP_TASK_REQUESTS: bool = Field(
            default=True,
            description=(
                "Skip Open WebUI's internal task requests (title, tags, search "
                "queries). They never answer the user and the rules only waste "
                "context there."
            ),
        )
        EMIT_STATUS: bool = Field(
            default=True,
            description="Emit a short status update when instructions are injected, so it is visible that the filter fired.",
        )
        MAX_CHARS: int = Field(
            default=16000,
            description=(
                "Refuse to inject more than this many characters. A guard against a runaway "
                "INSTRUCTIONS value, not a tuning knob: INSTRUCTIONS=both is the largest mode "
                "at roughly 12.5k characters, so leave headroom when the prompt grows."
            ),
        )

    def __init__(self):
        self.valves = self.Valves()

    # -- detection ---------------------------------------------------------

    def _targets(self) -> List[str]:
        return [t for t in (_canon(x) for x in (self.valves.TOOL_TARGETS or "").split(",")) if t]

    def _attached(self, body: Dict[str, Any], metadata: Dict[str, Any]) -> bool:
        """Is the tool enabled for this request?

        Where the tool list lives has moved between Open WebUI releases (top-level
        tool_ids, metadata.tool_ids, a rendered OpenAI tools array) and there is no
        way to pin a version here. So: look at the containers that can carry it, and
        harvest strings from any key whose name mentions tools, rather than betting on
        one key name. Matching is strict (id equality or an "id__" prefix), so prose
        that happens to contain the tool name cannot trigger it.
        """
        targets = self._targets()
        if not targets:
            return False

        chat = body.get("chat")
        containers = [body, metadata, chat, (chat or {}).get("metadata") if isinstance(chat, dict) else None]

        for container in containers:
            if not isinstance(container, dict):
                continue
            for key, value in container.items():
                if not isinstance(key, str) or "tool" not in key.lower():
                    continue
                for candidate in _strings(value):
                    if _matches(candidate, targets):
                        return True
        return False

    def _used(self, messages: List[Dict[str, Any]]) -> bool:
        """Does the history already show a call or result for this tool?"""
        targets = self._targets()
        if not targets:
            return False

        for message in messages:
            if not isinstance(message, dict):
                continue
            role = message.get("role")

            # A tool result. Open WebUI carries the rendered name here.
            if role == "tool":
                for key in ("name", "tool_name"):
                    if _matches(message.get(key), targets):
                        return True
                # Some builds only keep the call id, which embeds the tool id.
                if _matches(message.get("tool_call_id"), targets):
                    return True

            # An assistant turn that requested the call.
            for call in message.get("tool_calls") or []:
                if not isinstance(call, dict):
                    continue
                function = call.get("function")
                if isinstance(function, dict) and _matches(function.get("name"), targets):
                    return True
                if _matches(call.get("name"), targets):
                    return True
        return False

    # -- injection ---------------------------------------------------------

    @staticmethod
    def _text_of(message: Dict[str, Any]) -> str:
        """Message content as text, tolerating the multimodal parts form."""
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, str):
                    parts.append(part)
                elif isinstance(part, dict) and isinstance(part.get("text"), str):
                    parts.append(part["text"])
            return "\n".join(parts)
        return ""

    def _already_injected(self, messages: List[Dict[str, Any]]) -> bool:
        return any(
            isinstance(m, dict)
            and m.get("role") == "system"
            and INSTRUCTIONS_HEADER in self._text_of(m)
            for m in messages
        )

    def _prompt_already_present(self, messages: List[Dict[str, Any]]) -> bool:
        return any(
            isinstance(m, dict)
            and m.get("role") == "system"
            and SUPPRESS_IF_PRESENT in self._text_of(m)
            for m in messages
        )

    def _body_text(self) -> str:
        mode = (self.valves.INSTRUCTIONS or "compact").strip().lower()
        if mode == "full":
            return FULL_INSTRUCTIONS
        if mode == "both":
            return COMPACT_INSTRUCTIONS + "\n" + FULL_INSTRUCTIONS
        return COMPACT_INSTRUCTIONS

    def _emit_status(self, emitter: Any, reason: str) -> None:
        """Best-effort status event.

        inlet is deliberately synchronous: Open WebUI's documented signature returns the
        body, and a host that calls inlet without awaiting a coroutine would leave the
        injection on the floor with no error anywhere. So the event is scheduled rather
        than awaited, and dropped quietly when there is no loop to schedule it on.
        """
        if not self.valves.EMIT_STATUS or emitter is None:
            return
        try:
            pending = emitter(
                {
                    "type": "status",
                    "data": {"description": f"Metrics rules injected ({reason})", "done": True},
                }
            )
            if inspect.isawaitable(pending):
                try:
                    loop = asyncio.get_running_loop()
                except RuntimeError:
                    loop = None
                if loop is not None:
                    loop.create_task(pending)
                else:
                    # Nothing to run it on. Closing avoids an "never awaited" warning.
                    close = getattr(pending, "close", None)
                    if close is not None:
                        close()
        except Exception:
            pass

    def inlet(
        self,
        body: Dict[str, Any],
        __user__: Optional[Dict[str, Any]] = None,
        __metadata__: Optional[Dict[str, Any]] = None,
        __event_emitter__: Any = None,
    ) -> Dict[str, Any]:
        # A filter that raises breaks every chat it is attached to, so the whole thing
        # is wrapped: on any surprise, return the payload untouched and let the model
        # answer without the rules rather than not answer at all.
        try:
            messages = body.get("messages")
            if not isinstance(messages, list) or not messages:
                return body

            metadata = __metadata__ if isinstance(__metadata__, dict) else {}
            request_metadata = body.get("metadata")
            if isinstance(request_metadata, dict):
                merged = dict(metadata)
                merged.update(request_metadata)
                metadata = merged

            if self.valves.SKIP_TASK_REQUESTS and metadata.get("task"):
                return body

            if self._already_injected(messages):
                return body
            if self.valves.SKIP_IF_PROMPT_PRESENT and self._prompt_already_present(messages):
                return body

            trigger = (self.valves.TRIGGER or "either").strip().lower()
            attached = self._attached(body, metadata)
            used = self._used(messages)
            if trigger == "attachment" and not attached:
                return body
            if trigger == "use" and not used:
                return body
            if trigger not in ("attachment", "use") and not (attached or used):
                return body

            text = self._body_text().strip()
            if not text:
                return body
            if len(text) > int(self.valves.MAX_CHARS):
                # Refusing is right — half a prompt is worse than none — but doing it
                # silently would look exactly like a filter that never fired, which is
                # how a prompt that outgrew MAX_CHARS went unnoticed once already.
                self._emit_status(
                    __event_emitter__,
                    "Metrics instructions NOT injected: %d chars exceeds MAX_CHARS=%d"
                    % (len(text), int(self.valves.MAX_CHARS)),
                )
                return body

            injected = {"role": "system", "content": INSTRUCTIONS_HEADER + "\n\n" + text}

            # Sit after the model's own system prompt, not before it: the operator's
            # prompt is the frame, these are rules for a tool used inside it.
            index = 0
            while index < len(messages) and isinstance(messages[index], dict) and messages[index].get("role") == "system":
                index += 1
            messages.insert(index, injected)

            self._emit_status(
                __event_emitter__, "tool active" if attached else "tool used earlier in this chat"
            )
            return body
        except Exception:
            return body
