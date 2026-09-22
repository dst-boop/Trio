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
    for kind in ("start", "draft", "review", "final_start", "final_delta", "final", "done"):
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


def test_synthesizer_preference_is_respected(client, monkeypatch):
    monkeypatch.setenv("SYNTHESIZER", "gemini")
    out = client.post("/api/ask", json={"question": "hi", "stream": False}).json()
    assert out["written_by"] == "gemini"
