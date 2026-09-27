"""Per-caller throttling on /api/ask, the endpoint that spends API credits."""
import asyncio
import os

import pytest
from fastapi.testclient import TestClient

os.environ["TRIO_MOCK"] = "1"
os.environ.pop("APP_PASSWORD", None)

import main  # noqa: E402  (needs TRIO_MOCK set before import)

QUESTION = {"question": "What is 2+2?", "stream": False}


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        yield c


def test_limiter_allows_the_quota_then_asks_the_caller_to_wait():
    limiter = main.RateLimiter(per_minute=3)

    async def go():
        allowed = [await limiter.retry_after("1.2.3.4") for _ in range(3)]
        return allowed, await limiter.retry_after("1.2.3.4")

    allowed, blocked = asyncio.run(go())
    assert allowed == [0, 0, 0]
    assert 0 < blocked <= 61


def test_callers_are_counted_separately():
    limiter = main.RateLimiter(per_minute=1)

    async def go():
        return await limiter.retry_after("1.1.1.1"), await limiter.retry_after("2.2.2.2")

    assert asyncio.run(go()) == (0, 0)


def test_window_expiry_frees_the_caller_and_forgets_them():
    limiter = main.RateLimiter(per_minute=1, window=0.05)

    async def go():
        first = await limiter.retry_after("1.2.3.4")
        blocked = await limiter.retry_after("1.2.3.4")
        await asyncio.sleep(0.06)
        return first, blocked, await limiter.retry_after("1.2.3.4")

    first, blocked, after = asyncio.run(go())
    assert (first, after) == (0, 0)
    assert blocked > 0
    assert list(limiter._hits) == ["1.2.3.4"]  # pruned to just the live caller


def test_zero_disables_the_limit():
    limiter = main.RateLimiter(per_minute=0)

    async def go():
        return [await limiter.retry_after("1.2.3.4") for _ in range(50)]

    assert asyncio.run(go()) == [0] * 50


def test_ask_refuses_with_429_and_retry_after(client, monkeypatch):
    monkeypatch.setattr(main.app.state, "limiter", main.RateLimiter(per_minute=1))
    assert client.post("/api/ask", json=QUESTION).status_code == 200
    blocked = client.post("/api/ask", json=QUESTION)
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) >= 1


def test_throttling_happens_before_the_password_is_checked(client, monkeypatch):
    # Otherwise a password guesser is unthrottled: wrong guesses would never count.
    monkeypatch.setenv("APP_PASSWORD", "s3cret")
    monkeypatch.setattr(main.app.state, "limiter", main.RateLimiter(per_minute=1))
    assert client.post("/api/ask", json=QUESTION).status_code == 401
    assert client.post("/api/ask", json=QUESTION).status_code == 429


def test_forwarded_header_is_ignored_unless_the_proxy_is_trusted(client, monkeypatch):
    monkeypatch.delenv("TRUST_PROXY_HEADER", raising=False)
    monkeypatch.setattr(main.app.state, "limiter", main.RateLimiter(per_minute=1))
    assert client.post("/api/ask", json=QUESTION).status_code == 200
    # A spoofable header must not hand the caller a fresh quota.
    spoofed = client.post("/api/ask", json=QUESTION, headers={"X-Forwarded-For": "9.9.9.9"})
    assert spoofed.status_code == 429


def test_trusted_proxy_header_separates_callers(client, monkeypatch):
    monkeypatch.setenv("TRUST_PROXY_HEADER", "1")
    monkeypatch.setattr(main.app.state, "limiter", main.RateLimiter(per_minute=1))
    first = client.post("/api/ask", json=QUESTION, headers={"X-Forwarded-For": "9.9.9.9, 10.0.0.1"})
    second = client.post("/api/ask", json=QUESTION, headers={"X-Forwarded-For": "8.8.8.8"})
    repeat = client.post("/api/ask", json=QUESTION, headers={"X-Forwarded-For": "9.9.9.9"})
    assert (first.status_code, second.status_code, repeat.status_code) == (200, 200, 429)


def test_wrong_passwords_are_throttled_on_every_protected_endpoint(client, monkeypatch):
    # /api/status is free to call, so without this it is an unthrottled password oracle.
    monkeypatch.setenv("APP_PASSWORD", "s3cret")
    monkeypatch.setattr(main.app.state, "password_failures", main.RateLimiter(per_minute=2))
    wrong = {"X-App-Password": "guess"}
    assert client.get("/api/status", headers=wrong).status_code == 401
    assert client.get("/api/conversations/" + "a" * 32, headers=wrong).status_code == 401
    blocked = client.get("/api/status", headers=wrong)
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) >= 1
    # Locked out everywhere, even with the right password, until the window passes.
    assert client.get("/api/status", headers={"X-App-Password": "s3cret"}).status_code == 429
    assert client.delete("/api/conversations/" + "a" * 32, headers=wrong).status_code == 429


def test_correct_passwords_never_count_towards_the_lockout(client, monkeypatch):
    monkeypatch.setenv("APP_PASSWORD", "s3cret")
    monkeypatch.setattr(main.app.state, "password_failures", main.RateLimiter(per_minute=1))
    right = {"X-App-Password": "s3cret"}
    assert [client.get("/api/status", headers=right).status_code for _ in range(5)] == [200] * 5


def test_looking_does_not_count_against_the_caller():
    limiter = main.RateLimiter(per_minute=1)

    async def go():
        looks = [await limiter.retry_after("1.2.3.4", count=False) for _ in range(5)]
        await limiter.note("1.2.3.4")
        return looks, await limiter.retry_after("1.2.3.4", count=False)

    looks, after = asyncio.run(go())
    assert looks == [0] * 5 and after >= 1
