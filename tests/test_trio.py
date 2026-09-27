"""End-to-end tests in mock mode (TRIO_MOCK=1): no API keys, no network."""
import os

import pytest
from fastapi.testclient import TestClient

os.environ["TRIO_MOCK"] = "1"
os.environ.pop("APP_PASSWORD", None)

import main  # noqa: E402  (needs TRIO_MOCK set before import)


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        yield c


def test_healthz(client):
    assert client.get("/healthz").json() == {"ok": True}


def test_index_serves_app(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "<title>Trio</title>" in r.text


def test_status_lists_all_three_models(client):
    s = client.get("/api/status").json()
    assert s["mock"] is True
    assert {m["key"] for m in s["models"]} == {"claude", "openai", "gemini"}


def test_ask_returns_synthesised_answer(client):
    r = client.post("/api/ask", json={"question": "What is 2+2?", "stream": False})
    assert r.status_code == 200
    out = r.json()
    assert set(out["drafts"]) == {"claude", "openai", "gemini"}
    assert set(out["reviews"]) == {"claude", "openai", "gemini"}
    assert out["answer"]
    assert out["written_by"] in ("claude", "openai", "gemini")


def test_quick_mode_skips_reviews(client):
    r = client.post("/api/ask", json={"question": "hi", "thorough": False, "stream": False})
    out = r.json()
    assert out["reviews"] == {}
    assert out["answer"]


def _sse_events(body: str) -> list[dict]:
    import json
    return [json.loads(line[5:]) for line in body.split("\n\n") if line.startswith("data:")]


def test_ask_streams_events(client):
    with client.stream("POST", "/api/ask", json={"question": "hi", "stream": True}) as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    kinds = [e["type"] for e in _sse_events(body)]
    for kind in ("start", "draft_start", "draft_delta", "draft", "review",
                 "final_start", "final_delta", "final", "done"):
        assert kind in kinds, f"missing {kind!r} event"


def test_final_answer_streams_in_chunks(client):
    with client.stream("POST", "/api/ask", json={"question": "hi", "stream": True}) as r:
        events = _sse_events("".join(r.iter_text()))
    deltas = [e for e in events if e["type"] == "final_delta"]
    final = next(e for e in events if e["type"] == "final")
    assert len(deltas) > 3, "final answer should arrive in many chunks"
    assert "".join(d["text"] for d in deltas).strip() == final["text"]
    assert all(d["by"] == final["by"] for d in deltas)


def test_rejects_bad_history_role(client):
    r = client.post("/api/ask", json={
        "question": "hi", "stream": False,
        "history": [{"role": "system", "content": "x"}],
    })
    assert r.status_code == 422


def test_password_required_when_set(client, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "s3cret")
    assert client.get("/api/status").status_code == 401
    assert client.post("/api/ask", json={"question": "hi"}).status_code == 401
    ok = client.get("/api/status", headers={"X-App-Password": "s3cret"})
    assert ok.status_code == 200


def test_no_providers_yields_helpful_error(client, monkeypatch):
    monkeypatch.delenv("TRIO_MOCK", raising=False)
    for var in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    out = client.post("/api/ask", json={"question": "hi", "stream": False}).json()
    assert "No API keys" in out["error"]


def test_draft_deltas_reassemble_into_each_draft(client):
    with client.stream("POST", "/api/ask", json={"question": "hi", "stream": True}) as r:
        events = _sse_events("".join(r.iter_text()))
    drafts = {e["model"]: e["text"] for e in events if e["type"] == "draft" and e["text"]}
    assert len(drafts) == 3
    for model, text in drafts.items():
        chunks = [e["text"] for e in events if e["type"] == "draft_delta" and e["model"] == model]
        assert len(chunks) > 3, f"{model}'s draft should arrive in many chunks"
        assert "".join(chunks).strip() == text


def test_streams_require_their_completion_marker():
    """An HTTP-clean close before the vendor's completion marker must raise,
    never pass a truncated answer off as complete (Codex review, PR #7)."""
    import asyncio

    import httpx

    from providers import ProviderError, stream_claude, stream_gemini, stream_openai

    def collect(fn, body: str):
        async def go():
            transport = httpx.MockTransport(lambda req: httpx.Response(200, content=body.encode()))
            async with httpx.AsyncClient(transport=transport) as client:
                return [p async for p in fn(client, "m", "k", "sys", [{"role": "user", "content": "q"}])]
        return asyncio.run(go())

    cases = [
        (stream_claude,
         'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi "}}\n\n'
         'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"there"}}\n\n',
         'data: {"type":"message_stop"}\n\n'),
        (stream_openai,
         'data: {"choices":[{"delta":{"content":"hi "}}]}\n\n'
         'data: {"choices":[{"delta":{"content":"there"}}]}\n\n',
         'data: [DONE]\n\n'),
        (stream_gemini,
         'data: {"candidates":[{"content":{"parts":[{"text":"hi "}]}}]}\n\n',
         'data: {"candidates":[{"content":{"parts":[{"text":"there"}]},"finishReason":"STOP"}]}\n\n'),
    ]
    for fn, deltas, marker in cases:
        assert collect(fn, deltas + marker) == ["hi ", "there"], fn.__name__
        with pytest.raises(ProviderError, match="truncated"):
            collect(fn, deltas)


def test_broken_draft_stream_restarts_and_recovers(monkeypatch):
    """A draft stream that dies after emitting chunks re-emits draft_start and
    the non-streaming retry's text becomes the draft (issue #3 acceptance)."""
    import asyncio

    import orchestrator
    from providers import Provider

    async def ask(client, model, key, system, messages, usage=None):
        return "recovered draft" if "reviewer" not in system.lower() else "review"

    async def dying_stream(client, model, key, system, messages, usage=None):
        yield "doomed "
        raise RuntimeError("stream died")

    async def fine_stream(client, model, key, system, messages, usage=None):
        yield "fine "
        yield "answer"

    providers = [
        Provider("claude", "Claude", "m", "k", ask, dying_stream),
        Provider("openai", "ChatGPT", "m", "k", ask, fine_stream),
    ]
    monkeypatch.setattr(orchestrator, "active_providers", lambda: providers)

    async def collect():
        return [ev async for ev in orchestrator.run(None, "q", thorough=False)]

    events = asyncio.run(collect())
    claude = [e for e in events if e.get("model") == "claude"]
    starts = [e for e in claude if e["type"] == "draft_start"]
    draft = next(e for e in claude if e["type"] == "draft")
    assert len(starts) == 2, "the abandoned draft stream must signal a restart"
    assert draft["text"] == "recovered draft" and draft["error"] is None
    openai_draft = next(e for e in events if e.get("model") == "openai" and e["type"] == "draft")
    assert openai_draft["text"] == "fine answer"


def test_broken_stream_restarts_the_final_answer(monkeypatch):
    """A stream that dies after emitting chunks must signal a restart, or
    consumers that already showed the abandoned prefix keep it (Codex review,
    PR #2): a fresh final_start precedes the non-streaming retry's answer."""
    import asyncio

    import orchestrator
    from providers import Provider

    async def draft(client, model, key, system, messages, usage=None):
        return "complete answer"

    async def dying_stream(client, model, key, system, messages, usage=None):
        yield "partial "
        raise RuntimeError("stream died")

    providers = [
        Provider("claude", "Claude", "m", "k", draft, dying_stream),
        Provider("openai", "ChatGPT", "m", "k", draft, None),
    ]
    monkeypatch.setattr(orchestrator, "active_providers", lambda: providers)

    async def collect():
        return [ev async for ev in orchestrator.run(None, "q", thorough=False)]

    events = asyncio.run(collect())
    starts = [i for i, e in enumerate(events) if e["type"] == "final_start"]
    deltas = [i for i, e in enumerate(events) if e["type"] == "final_delta"]
    final = next(e for e in events if e["type"] == "final")
    assert len(starts) == 2, "the abandoned stream must be followed by a restart"
    assert deltas and all(starts[0] < i < starts[1] for i in deltas)
    assert final["text"] == "complete answer" and final["by"] == "claude"


def test_final_event_reports_usage(client):
    out = client.post("/api/ask", json={"question": "hi", "stream": False}).json()
    u = out["usage"]
    assert set(u["models"]) == {"claude", "openai", "gemini"}
    assert u["input"] == sum(m["input"] for m in u["models"].values()) > 0
    assert u["output"] == sum(m["output"] for m in u["models"].values()) > 0
    assert u["cost"] is None  # mock "models" are not in the price table
    assert u["incomplete"] is False


def test_lost_stream_usage_never_prices_as_complete(monkeypatch):
    """A stream that emits billed content but dies before its usage frame
    (e.g. OpenAI's totals ride the final chunk) must mark the tally
    incomplete and withhold the cost (Codex review, PR #8)."""
    import asyncio

    import orchestrator
    from providers import Provider

    async def ask(client, model, key, system, messages, usage=None):
        if usage is not None:
            usage.update(input=100, output=50)
        return "recovered answer"

    async def dying_stream(client, model, key, system, messages, usage=None):
        yield "billed but uncounted "  # dies before the usage frame arrives
        raise RuntimeError("stream died")

    providers = [
        Provider("claude", "Claude", "claude-opus-5", "k", ask, dying_stream),
        Provider("openai", "ChatGPT", "claude-opus-5", "k", ask, None),
    ]
    monkeypatch.setattr(orchestrator, "active_providers", lambda: providers)

    async def collect():
        return [ev async for ev in orchestrator.run(None, "q", thorough=False)]

    events = asyncio.run(collect())
    usage = next(e for e in events if e["type"] == "final")["usage"]
    assert usage["incomplete"] is True
    assert usage["cost"] is None, "an undercounted bill must not be priced as exact"
    assert usage["models"]["claude"]["input"] > 0  # the counted attempts still show
    for model in usage["models"].values():  # per-model prices would also read as exact
        assert "cost" not in model


def test_pre_delta_stream_failure_is_potentially_undercounted(monkeypatch):
    """A stream that fails before its first delta may still have been accepted
    and billed; the tally must be marked incomplete (Codex review, PR #12)."""
    import asyncio

    import orchestrator
    from providers import Provider

    async def ask(client, model, key, system, messages, usage=None):
        if usage is not None:
            usage.update(input=100, output=50)
        return "recovered answer"

    async def instant_death(client, model, key, system, messages, usage=None):
        raise RuntimeError("connection lost before any delta")
        yield  # pragma: no cover - makes this an async generator

    providers = [
        Provider("claude", "Claude", "claude-opus-5", "k", ask, instant_death),
        Provider("openai", "ChatGPT", "claude-opus-5", "k", ask, None),
    ]
    monkeypatch.setattr(orchestrator, "active_providers", lambda: providers)

    async def collect():
        return [ev async for ev in orchestrator.run(None, "q", thorough=False)]

    events = asyncio.run(collect())
    usage = next(e for e in events if e["type"] == "final")["usage"]
    assert usage["incomplete"] is True
    assert usage["cost"] is None


def test_cost_estimate_uses_price_table():
    from providers import estimate_cost
    assert estimate_cost("claude-opus-5", 1_000_000, 1_000_000) == 30.0
    assert estimate_cost("claude-opus-5", 200_000, 40_000) == 2.0
    assert estimate_cost("some-unknown-model", 1000, 1000) is None


def test_synthesizer_preference_is_respected(client, monkeypatch):
    monkeypatch.setenv("SYNTHESIZER", "gemini")
    out = client.post("/api/ask", json={"question": "hi", "stream": False}).json()
    assert out["written_by"] == "gemini"


def test_markdown_scripts_are_served_locally():
    # The page must not depend on a third-party CDN for scripts that see its content.
    from fastapi.testclient import TestClient
    import main
    with TestClient(main.app) as client:
        page = client.get("/").text
        assert "cdnjs" not in page
        for path in ("/vendor/marked-12.0.2.min.js", "/vendor/purify-3.1.6.min.js"):
            assert path in page
            response = client.get(path)
            assert response.status_code == 200 and "javascript" in response.headers["content-type"]


def _fallback_run(monkeypatch, review_text):
    """Three drafts, every synthesis fails; reviews come from review_text(context)."""
    import asyncio

    import orchestrator
    from providers import Provider

    drafts = {"claude": "Short but right.", "openai": "A much longer answer " * 20, "gemini": "Medium length answer here."}

    def make(key):
        async def ask(client, model, k, system, messages, usage=None):
            if "final answer" in system.lower():
                raise RuntimeError("synthesis unavailable")
            if "reviewer" in system.lower():
                return review_text(messages[-1]["content"])
            return drafts[key]
        return ask

    providers = [Provider(key, key.title(), "m", "k", make(key), None) for key in drafts]
    monkeypatch.setattr(orchestrator, "active_providers", lambda: providers)

    async def collect():
        return [ev async for ev in orchestrator.run(None, "q")]

    return next(e for e in asyncio.run(collect()) if e["type"] == "final")


def test_fallback_prefers_the_draft_reviewers_rated_strongest(monkeypatch):
    import re

    def vote_for_short(context):
        # Name whichever anonymised letter holds the short draft.
        letter = re.search(r"### Response ([A-Z])\nShort but right\.", context).group(1)
        return f"Analysis...\n**Strongest:** Response {letter}"

    final = _fallback_run(monkeypatch, vote_for_short)
    assert final["fallback"] is True
    assert final["by"] == "claude" and final["text"] == "Short but right."
    assert "rated strongest" in final["note"]


def test_fallback_uses_the_longest_draft_without_a_verdict(monkeypatch):
    final = _fallback_run(monkeypatch, lambda context: "No clear winner.")
    assert final["by"] == "openai"
    assert "most complete" in final["note"]


def _independent_run(monkeypatch, fail_writer=False, keys=("claude", "openai", "gemini")):
    """Record which stage each model is called for, with claude as the independent synthesizer."""
    import asyncio

    import orchestrator
    from providers import Provider

    calls = []

    def make(key):
        async def ask(client, model, k, system, messages, usage=None):
            stage = "final" if "final answer" in system.lower() else "review" if "reviewer" in system.lower() else "draft"
            calls.append((key, stage))
            if fail_writer and key == "claude" and stage == "final":
                raise RuntimeError("writer unavailable")
            return f"{key} {stage}"
        return ask

    providers = [Provider(key, key.title(), "m", "k", make(key), None) for key in keys]
    monkeypatch.setattr(orchestrator, "active_providers", lambda: providers)

    async def collect():
        return [ev async for ev in orchestrator.run(None, "q", synthesizer="claude", independent_synthesizer=True)]

    return asyncio.run(collect()), calls


def test_independent_synthesizer_only_writes_the_final_answer(monkeypatch):
    events, calls = _independent_run(monkeypatch)
    assert [stage for key, stage in calls if key == "claude"] == ["final"]
    assert {key for key, stage in calls if stage == "draft"} == {"openai", "gemini"}
    assert {key for key, stage in calls if stage == "review"} == {"openai", "gemini"}
    final = next(e for e in events if e["type"] == "final")
    assert final["by"] == "claude" and final["independent"] is True and final["text"] == "claude final"
    assert next(e for e in events if e["type"] == "start")["independent_synthesizer"] is True


def test_independent_synthesizer_falls_back_to_a_drafter(monkeypatch):
    events, _ = _independent_run(monkeypatch, fail_writer=True)
    final = next(e for e in events if e["type"] == "final")
    assert final["by"] in {"openai", "gemini"} and "independent" not in final


def test_independent_synthesizer_needs_three_models(monkeypatch):
    events, calls = _independent_run(monkeypatch, keys=("claude", "openai"))
    assert events == [{"type": "error", "message": "An independent synthesizer needs three configured models, including the synthesizer."}]
    assert calls == []


def test_api_accepts_independent_synthesizer(client):
    r = client.post("/api/ask", json={"question": "Plan?", "stream": False, "synthesizer": "gemini", "independent_synthesizer": True})
    assert r.status_code == 200
    body = r.json()
    assert body["written_by"] == "gemini" and body["independent"] is True
    assert "gemini" not in body["drafts"]
