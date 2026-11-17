#!/usr/bin/env python3
"""Behavioural checks for the Discord Metrics Instructions filter.

Open WebUI loads a filter as a single Python file and calls `inlet` on every request,
so the interesting logic is all decision-making: does this request concern the metrics
tool, and has the block already been inserted. That can be tested without Open WebUI,
which is what this does — no network, no API, no pydantic beyond the module import.

Run directly (`python3 openwebui/filter_selftest.py`) or via `npm test`.
"""

import asyncio
import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics_filter as f  # noqa: E402

CHECKS = []


def check(name):
    def wrap(fn):
        CHECKS.append((name, fn))
        return fn

    return wrap


class Emitter:
    def __init__(self):
        self.events = []

    async def __call__(self, event):
        self.events.append(event)


def make_filter(**valves):
    instance = f.Filter()
    for key, value in valves.items():
        setattr(instance.valves, key, value)
    return instance


async def _inlet_and_drain(instance, payload, metadata, emitter):
    """inlet is sync; run it on a loop so a scheduled status event can execute."""
    result = instance.inlet(
        payload, __user__={"id": "u"}, __metadata__=metadata or {}, __event_emitter__=emitter
    )
    await asyncio.sleep(0)
    return result


def run(instance, body, metadata=None, emitter=None):
    """Call inlet the way Open WebUI would, returning (body, injected messages, emitter)."""
    emitter = emitter or Emitter()
    payload = copy.deepcopy(body)
    result = asyncio.run(_inlet_and_drain(instance, payload, metadata, emitter))
    systems = [m for m in result["messages"] if m.get("role") == "system"]
    injected = [m for m in systems if f.INSTRUCTIONS_HEADER in (m.get("content") or "")]
    return result, injected, emitter


MESSAGES = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "how is the server doing"},
]

ATTACHED = {"tool_ids": ["discord_metrics"]}
USED = {
    "messages": MESSAGES
    + [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"function": {"name": "discord_metrics__get_server_summary", "arguments": "{}"}, "id": "call_1"}
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "name": "discord_metrics__get_server_summary", "content": "{}"},
        {"role": "assistant", "content": "We did 400 messages."},
        {"role": "user", "content": "and the quiet channels?"},
    ]
}


@check("no tool anywhere: request untouched")
def _():
    body, injected, emitter = run(make_filter(), {"messages": MESSAGES})
    assert len(injected) == 0, "injected without the tool"
    assert body["messages"] == MESSAGES, "payload mutated"
    assert emitter.events == [], "status emitted with nothing to say"


@check("attached by tool id: injected once, after the operator prompt")
def _():
    body, injected, emitter = run(make_filter(), {"messages": MESSAGES, **ATTACHED})
    assert len(injected) == 1, f"expected 1 injected message, got {len(injected)}"
    assert body["messages"][0] == MESSAGES[0], "operator system prompt moved"
    assert body["messages"][1]["role"] == "system", "injection not after the operator prompt"
    assert body["messages"][2]["role"] == "user", "user turn displaced"
    assert len(emitter.events) == 1, "no status event"


@check("attached as an OpenAI tool spec: injected")
def _():
    body = {
        "messages": MESSAGES,
        "tools": [
            {
                "type": "function",
                "function": {"name": "discord_metrics__get_activity_series", "parameters": {}},
            }
        ],
    }
    _, injected, _ = run(make_filter(), body)
    assert len(injected) == 1, "missed the function-spec shape"


@check("used earlier, no longer attached: injected")
def _():
    _, injected, _ = run(make_filter(), copy.deepcopy(USED))
    assert len(injected) == 1, "history-based detection failed"


@check("tool_call_id alone is enough to see prior use")
def _():
    body = {
        "messages": MESSAGES
        + [{"role": "tool", "tool_call_id": "discord_metrics__get_voice_activity", "content": "{}"}]
    }
    _, injected, _ = run(make_filter(), body)
    assert len(injected) == 1, "missed the call-id-only tool result"


@check("TRIGGER=attachment ignores history-only use")
def _():
    _, injected, _ = run(make_filter(TRIGGER="attachment"), copy.deepcopy(USED))
    assert len(injected) == 0, "attachment trigger fired on history alone"


@check("TRIGGER=use ignores mere attachment")
def _():
    _, injected, _ = run(make_filter(TRIGGER="use"), {"messages": MESSAGES, **ATTACHED})
    assert len(injected) == 0, "use trigger fired on attachment alone"


@check("idempotent across turns")
def _():
    instance = make_filter()
    body = copy.deepcopy({"messages": MESSAGES, **ATTACHED})
    for _turn in range(3):
        asyncio.run(_inlet_and_drain(instance, body, {}, None))
    count = sum(1 for m in body["messages"] if f.INSTRUCTIONS_HEADER in (m.get("content") or ""))
    assert count == 1, f"injected {count} times"


@check("inlet returns the body synchronously, so no host can drop it")
def _():
    instance = make_filter()
    body = copy.deepcopy({"messages": MESSAGES, **ATTACHED})
    result = instance.inlet(body, __metadata__={})
    assert not asyncio.iscoroutine(result), "inlet returned a coroutine"
    assert f.INSTRUCTIONS_HEADER in result["messages"][1]["content"], "injection lost"


@check("a synchronous event emitter does not break injection")
def _():
    seen = []

    def sync_emitter(event):
        seen.append(event)

    _, injected, _ = run(make_filter(), {"messages": MESSAGES, **ATTACHED}, emitter=sync_emitter)
    assert len(injected) == 1, "sync emitter broke injection"
    assert len(seen) == 1, "status not emitted by a sync emitter"


@check("EMIT_STATUS off emits nothing")
def _():
    _, _, emitter = run(make_filter(EMIT_STATUS=False), {"messages": MESSAGES, **ATTACHED})
    assert emitter.events == [], "status emitted despite the valve"


@check("suppressed when SYSTEM_PROMPT.md is already in the model prompt")
def _():
    body = {
        "messages": [
            {"role": "system", "content": f"{f.SUPPRESS_IF_PRESENT}\n\nlots of other rules"},
            {"role": "user", "content": "hi"},
        ],
        **ATTACHED,
    }
    _, injected, _ = run(make_filter(), body)
    assert len(injected) == 0, "duplicated a prompt the model already has"


@check("suppression can be turned off")
def _():
    body = {
        "messages": [
            {"role": "system", "content": f"{f.SUPPRESS_IF_PRESENT}\n\ntext"},
            {"role": "user", "content": "hi"},
        ],
        **ATTACHED,
    }
    _, injected, _ = run(make_filter(SKIP_IF_PROMPT_PRESENT=False), body)
    assert len(injected) == 1, "valve ignored"


@check("task requests are skipped")
def _():
    _, injected, _ = run(
        make_filter(), {"messages": MESSAGES, **ATTACHED}, metadata={"task": "title_generation"}
    )
    assert len(injected) == 0, "injected into a title-generation task"


@check("attachment found wherever this Open WebUI version puts the tool list")
def _():
    variants = {
        "top-level tool_ids": {"tool_ids": ["discord_metrics"]},
        "top-level tools str": {"tools": ["discord_metrics"]},
        "metadata.tool_ids": {"metadata": {"tool_ids": ["discord_metrics"]}},
        "chat.tool_ids": {"chat": {"tool_ids": ["discord_metrics"]}},
        "chat.metadata.tool_ids": {"chat": {"metadata": {"tool_ids": ["discord_metrics"]}}},
        "openai function spec": {
            "tools": [{"type": "function", "function": {"name": "discord_metrics__get_server_summary"}}]
        },
    }
    for label, extra in variants.items():
        _, injected, _ = run(make_filter(), {"messages": MESSAGES, **extra})
        assert len(injected) == 1, f"missed attachment shape: {label}"


@check("prose mentioning the tool name does not count as attachment")
def _():
    body = {
        "messages": MESSAGES
        + [{"role": "user", "content": "is discord_metrics__get_server_summary working? the discord_metrics tool seems off"}]
    }
    _, injected, _ = run(make_filter(), body)
    assert len(injected) == 0, "a user message mentioning the tool triggered injection"


@check("unrelated tool does not trigger")
def _():
    body = {"messages": MESSAGES, "tool_ids": ["weather", "calculator"]}
    _, injected, _ = run(make_filter(), body)
    assert len(injected) == 0, "fired on an unrelated tool"


@check("a lookalike prefix does not trigger")
def _():
    body = {"messages": MESSAGES, "tool_ids": ["discord_metrics_archive_v2"]}
    _, injected, _ = run(make_filter(), body)
    assert len(injected) == 0, "prefix match was not anchored"


@check("INSTRUCTIONS=full injects the whole prompt")
def _():
    body, injected, _ = run(make_filter(INSTRUCTIONS="full"), {"messages": MESSAGES, **ATTACHED})
    text = injected[0]["content"]
    assert "## Coverage: quiet versus blind" in text, "full prompt missing a section"
    assert text.index(f.INSTRUCTIONS_HEADER) == 0, "header not first"
    assert len(text) > 3000, "full prompt looks truncated"


@check("INSTRUCTIONS=both carries compact and full")
def _():
    body, injected, _ = run(make_filter(INSTRUCTIONS="both"), {"messages": MESSAGES, **ATTACHED})
    text = injected[0]["content"]
    assert "upper bound" in text and "## Coverage: quiet versus blind" in text, "both mode incomplete"


@check("compact covers the load-bearing rules")
def _():
    text = f.COMPACT_INSTRUCTIONS
    for needle in (
        "upper bound",
        "activity_known",
        "visibility_contradictions",
        "messages_from_invisible",
        "lower bound",
        "partial",
        "another bot's currency",
    ):
        assert needle in text, f"compact instructions lost: {needle}"


@check("MAX_CHARS refuses an oversized injection")
def _():
    _, injected, _ = run(make_filter(MAX_CHARS=50), {"messages": MESSAGES, **ATTACHED})
    assert len(injected) == 0, "size guard ignored"


@check("empty or missing messages are inert")
def _():
    for body in ({"messages": []}, {"messages": None}, {}, {"messages": "nope"}, {"messages": ATTACHED}):
        instance = make_filter()
        result = asyncio.run(_inlet_and_drain(instance, copy.deepcopy(body), {}, None))
        assert isinstance(result, dict), f"not a dict for {body!r}"


@check("multimodal content parts do not crash the marker scan")
def _():
    body = {
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": "be brief"}]},
            {"role": "user", "content": [{"type": "text", "text": "how is growth"}]},
        ],
        **ATTACHED,
    }
    result, injected, _ = run(make_filter(), body)
    assert len(injected) == 1, "parts form broke detection"
    assert result["messages"][0]["content"] == [{"type": "text", "text": "be brief"}], "operator prompt altered"


@check("full and compact text stay in sync with SYSTEM_PROMPT.md")
def _():
    here = os.path.dirname(os.path.abspath(__file__))
    prompt = open(os.path.join(here, "SYSTEM_PROMPT.md"), encoding="utf-8").read()
    assert f.FULL_INSTRUCTIONS == prompt, "run: node scripts/sync-prompt.mjs --write"


def main():
    failed = 0
    for name, fn in CHECKS:
        try:
            fn()
        except AssertionError as exc:
            failed += 1
            print(f"FAIL  {name}\n        {exc}")
        except Exception as exc:  # noqa: BLE001 - report, do not abort the suite
            failed += 1
            print(f"ERROR {name}\n        {type(exc).__name__}: {exc}")
    print(f"{len(CHECKS) - failed}/{len(CHECKS)} filter checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
