"""Provider layer: one small async function per vendor.

Plain HTTPS calls (no vendor SDKs) so there is nothing to keep in sync
except the model names in your .env file.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable

import httpx

Message = dict  # {"role": "user" | "assistant", "content": str}

RETRY_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}
MAX_ATTEMPTS = 3


class ProviderError(Exception):
    pass


def _max_tokens() -> int:
    return int(os.getenv("MAX_OUTPUT_TOKENS", "4000"))


async def _post(client: httpx.AsyncClient, url: str, headers: dict, body: dict) -> dict:
    """POST with backoff on rate limits and transient server errors."""
    last = "unknown error"
    for attempt in range(MAX_ATTEMPTS):
        try:
            r = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as e:
            last = f"network error: {e.__class__.__name__}"
        else:
            if r.status_code < 300:
                return r.json()
            try:
                err = r.json().get("error", {})
                detail = err.get("message") if isinstance(err, dict) else str(err)
            except Exception:
                detail = r.text[:300]
            last = f"HTTP {r.status_code}: {detail}"
            if r.status_code not in RETRY_STATUS:
                break
            retry_after = r.headers.get("retry-after")
            if retry_after and retry_after.replace(".", "", 1).isdigit():
                await asyncio.sleep(min(float(retry_after), 20))
                continue
        await asyncio.sleep((2 ** attempt) + random.random())
    raise ProviderError(last)


async def _sse(client: httpx.AsyncClient, url: str, headers: dict, body: dict) -> AsyncIterator[dict]:
    """POST a streaming request and yield each SSE data payload as a dict."""
    async with client.stream("POST", url, headers=headers, json=body) as r:
        if r.status_code >= 300:
            detail = (await r.aread()).decode(errors="replace")[:300]
            raise ProviderError(f"HTTP {r.status_code}: {detail}")
        async for line in r.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data and data != "[DONE]":
                yield json.loads(data)


# --------------------------------------------------------------------------
# Claude (Anthropic Messages API)
# --------------------------------------------------------------------------
async def ask_claude(client, model, key, system: str, messages: list[Message]) -> str:
    data = await _post(
        client,
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": key, "anthropic-version": "2023-06-01"},
        {"model": model, "max_tokens": _max_tokens(), "system": system, "messages": messages},
    )
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    if not text.strip():
        raise ProviderError(f"empty response (stop_reason={data.get('stop_reason')})")
    return text.strip()


async def stream_claude(client, model, key, system: str, messages: list[Message]) -> AsyncIterator[str]:
    events = _sse(
        client,
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": key, "anthropic-version": "2023-06-01"},
        {"model": model, "max_tokens": _max_tokens(), "system": system,
         "messages": messages, "stream": True},
    )
    async for ev in events:
        if ev.get("type") == "content_block_delta":
            delta = ev.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                yield delta["text"]
        elif ev.get("type") == "error":
            raise ProviderError((ev.get("error") or {}).get("message") or "stream error")


# --------------------------------------------------------------------------
# ChatGPT (OpenAI Chat Completions API)
# Note: current OpenAI reasoning models reject custom temperature, so none is sent.
# --------------------------------------------------------------------------
async def ask_openai(client, model, key, system: str, messages: list[Message]) -> str:
    data = await _post(
        client,
        "https://api.openai.com/v1/chat/completions",
        {"Authorization": f"Bearer {key}"},
        {
            "model": model,
            # Reasoning tokens count against this limit, so give extra headroom.
            "max_completion_tokens": _max_tokens() * 3,
            "messages": [{"role": "developer", "content": system}, *messages],
        },
    )
    choice = (data.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    if not text.strip():
        raise ProviderError(f"empty response (finish_reason={choice.get('finish_reason')})")
    return text.strip()


async def stream_openai(client, model, key, system: str, messages: list[Message]) -> AsyncIterator[str]:
    events = _sse(
        client,
        "https://api.openai.com/v1/chat/completions",
        {"Authorization": f"Bearer {key}"},
        {"model": model, "max_completion_tokens": _max_tokens() * 3,
         "messages": [{"role": "developer", "content": system}, *messages], "stream": True},
    )
    async for ev in events:
        piece = ((ev.get("choices") or [{}])[0].get("delta") or {}).get("content")
        if piece:
            yield piece


# --------------------------------------------------------------------------
# Gemini (Google generateContent API)
# --------------------------------------------------------------------------
async def ask_gemini(client, model, key, system: str, messages: list[Message]) -> str:
    contents = [
        {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
        for m in messages
    ]
    data = await _post(
        client,
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        {"x-goog-api-key": key},
        {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": {"maxOutputTokens": _max_tokens() * 3},
        },
    )
    cand = (data.get("candidates") or [{}])[0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    if not text.strip():
        reason = cand.get("finishReason") or (data.get("promptFeedback") or {}).get("blockReason")
        raise ProviderError(f"empty response (reason={reason})")
    return text.strip()


async def stream_gemini(client, model, key, system: str, messages: list[Message]) -> AsyncIterator[str]:
    contents = [
        {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
        for m in messages
    ]
    events = _sse(
        client,
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
        {"x-goog-api-key": key},
        {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": contents,
            "generationConfig": {"maxOutputTokens": _max_tokens() * 3},
        },
    )
    async for ev in events:
        for p in ((ev.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []:
            if p.get("text") and not p.get("thought"):
                yield p["text"]


# --------------------------------------------------------------------------
# Mock provider: lets you try the whole app with no API keys (TRIO_MOCK=1)
# --------------------------------------------------------------------------
def _mock(label: str):
    async def ask(client, model, key, system: str, messages: list[Message]) -> str:
        await asyncio.sleep(0.4 + random.random() * 1.2)
        q = messages[-1]["content"]
        if "final answer" in system.lower():
            return f"**Mock final answer** written by {label}, combining all three drafts."
        if "review" in system.lower():
            return f"- {label} mock review: Response A is strongest; B misses a caveat."
        return f"Mock draft from **{label}** for: _{q[:80]}_"
    return ask


def _mock_stream(label: str):
    async def stream(client, model, key, system: str, messages: list[Message]) -> AsyncIterator[str]:
        text = f"**Mock final answer** streamed by {label}, combining all three drafts."
        for word in text.split(" "):
            await asyncio.sleep(0.05)
            yield word + " "
    return stream


@dataclass
class Provider:
    key: str          # "claude" | "openai" | "gemini"
    label: str        # shown in the UI
    model: str
    api_key: str
    fn: Callable[..., Awaitable[str]]
    stream_fn: Callable[..., AsyncIterator[str]] | None = None

    async def ask(self, client: httpx.AsyncClient, system: str, messages: list[Message]) -> str:
        return await self.fn(client, self.model, self.api_key, system, messages)

    def stream(self, client: httpx.AsyncClient, system: str, messages: list[Message]) -> AsyncIterator[str]:
        return self.stream_fn(client, self.model, self.api_key, system, messages)


def active_providers() -> list[Provider]:
    """Providers that have an API key configured (all three in mock mode)."""
    mock = os.getenv("TRIO_MOCK") == "1"
    specs = [
        ("claude", "Claude", "ANTHROPIC_API_KEY", "CLAUDE_MODEL", "claude-opus-5", ask_claude, stream_claude),
        ("openai", "ChatGPT", "OPENAI_API_KEY", "OPENAI_MODEL", "gpt-6-astra", ask_openai, stream_openai),
        ("gemini", "Gemini", "GEMINI_API_KEY", "GEMINI_MODEL", "gemini-3.8-flash", ask_gemini, stream_gemini),
    ]
    out = []
    for key, label, key_env, model_env, default_model, fn, stream_fn in specs:
        api_key = os.getenv(key_env, "").strip()
        if mock:
            out.append(Provider(key, label, "mock", "mock", _mock(label), _mock_stream(label)))
        elif api_key:
            out.append(Provider(key, label, os.getenv(model_env, default_model), api_key, fn, stream_fn))
    return out
