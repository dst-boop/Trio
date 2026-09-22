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

# USD per million tokens (input, output), for the cost shown with each answer.
# Prices change - update me. A model not listed here shows tokens only.
PRICES = {
    "claude-opus-5": (5.00, 25.00),
    "gpt-6-astra": (10.00, 50.00),
    "gemini-3.8-flash": (0.75, 3.75),  # intro rate; $1.50/$7.50 from Jan 2027
}


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float | None:
    """Estimated USD for one call, or None when the model has no price entry."""
    price = PRICES.get(model)
    if not price:
        return None
    return (input_tokens * price[0] + output_tokens * price[1]) / 1_000_000


class ProviderError(Exception):
    pass


def _max_tokens() -> int:
    return int(os.getenv("MAX_OUTPUT_TOKENS", "4000"))


def _http_error(status: int) -> str:
    """Provider bodies can echo keys or private prompts; never expose them."""
    if status in (401, 403):
        hint = "Check the API key and account access."
    elif status == 429:
        hint = "Rate limit or API credit limit reached."
    elif status == 404:
        hint = "Model unavailable. Check the configured model ID."
    elif status in (400, 422):
        hint = "The provider rejected the request. Check model compatibility and context length."
    else:
        hint = "The provider could not complete the request. Try again."
    return f"HTTP {status}: {hint}"


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
            last = _http_error(r.status_code)
            if r.status_code not in RETRY_STATUS:
                break
            retry_after = r.headers.get("retry-after")
            if retry_after and retry_after.replace(".", "", 1).isdigit():
                await asyncio.sleep(min(float(retry_after), 20))
                continue
        await asyncio.sleep((2 ** attempt) + random.random())
    raise ProviderError(last)


async def _sse(client: httpx.AsyncClient, url: str, headers: dict, body: dict) -> AsyncIterator[str]:
    """POST a streaming request and yield each SSE data payload string.

    Callers parse the payloads themselves and must verify their vendor's
    completion marker arrived: an HTTP-clean close mid-answer looks like a
    normal end of iteration here, and a truncated answer must never pass
    as a complete one.
    """
    async with client.stream("POST", url, headers=headers, json=body) as r:
        if r.status_code >= 300:
            raise ProviderError(_http_error(r.status_code))
        async for line in r.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data:
                yield data


# --------------------------------------------------------------------------
# Claude (Anthropic Messages API)
# --------------------------------------------------------------------------
async def ask_claude(client, model, key, system: str, messages: list[Message], usage: dict | None = None) -> str:
    data = await _post(
        client,
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": key, "anthropic-version": "2023-06-01"},
        {"model": model, "max_tokens": _max_tokens(), "system": system, "messages": messages},
    )
    if usage is not None:
        u = data.get("usage") or {}
        usage.update(input=u.get("input_tokens") or 0, output=u.get("output_tokens") or 0)
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    if not text.strip():
        raise ProviderError("No text returned. The response may be blocked or its output limit exhausted.")
    return text.strip()


async def stream_claude(client, model, key, system: str, messages: list[Message], usage: dict | None = None) -> AsyncIterator[str]:
    events = _sse(
        client,
        "https://api.anthropic.com/v1/messages",
        {"x-api-key": key, "anthropic-version": "2023-06-01"},
        {"model": model, "max_tokens": _max_tokens(), "system": system,
         "messages": messages, "stream": True},
    )
    done = False
    async for data in events:
        ev = json.loads(data)
        kind = ev.get("type")
        if kind == "content_block_delta":
            delta = ev.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                yield delta["text"]
        elif kind == "message_start" and usage is not None:
            u = (ev.get("message") or {}).get("usage") or {}
            usage["input"] = u.get("input_tokens") or 0
        elif kind == "message_delta" and usage is not None:
            u = ev.get("usage") or {}
            usage["output"] = u.get("output_tokens") or usage.get("output", 0)
        elif kind == "message_stop":
            done = True
        elif kind == "error":
            raise ProviderError("The provider interrupted the response stream. Try again.")
    if not done:
        raise ProviderError("stream ended before message_stop; answer may be truncated")


# --------------------------------------------------------------------------
# ChatGPT (OpenAI Chat Completions API)
# Note: current OpenAI reasoning models reject custom temperature, so none is sent.
# --------------------------------------------------------------------------
async def ask_openai(client, model, key, system: str, messages: list[Message], usage: dict | None = None) -> str:
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
    if usage is not None:
        u = data.get("usage") or {}
        usage.update(input=u.get("prompt_tokens") or 0, output=u.get("completion_tokens") or 0)
    choice = (data.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    if not text.strip():
        raise ProviderError("No text returned. The response may be blocked or its output limit exhausted.")
    return text.strip()


async def stream_openai(client, model, key, system: str, messages: list[Message], usage: dict | None = None) -> AsyncIterator[str]:
    events = _sse(
        client,
        "https://api.openai.com/v1/chat/completions",
        {"Authorization": f"Bearer {key}"},
        {"model": model, "max_completion_tokens": _max_tokens() * 3,
         "messages": [{"role": "developer", "content": system}, *messages],
         "stream": True, "stream_options": {"include_usage": True}},
    )
    done = False
    async for data in events:
        if data == "[DONE]":
            done = True
            break
        ev = json.loads(data)
        u = ev.get("usage")
        if u and usage is not None:  # final chunk before [DONE] carries the totals
            usage.update(input=u.get("prompt_tokens") or 0, output=u.get("completion_tokens") or 0)
        piece = ((ev.get("choices") or [{}])[0].get("delta") or {}).get("content")
        if piece:
            yield piece
    if not done:
        raise ProviderError("stream ended before [DONE]; answer may be truncated")


# --------------------------------------------------------------------------
# Gemini (Google generateContent API)
# --------------------------------------------------------------------------
def _gemini_usage(data: dict, usage: dict | None) -> None:
    u = data.get("usageMetadata")
    if u and usage is not None:  # thinking tokens are billed as output
        usage["input"] = u.get("promptTokenCount") or 0
        usage["output"] = (u.get("candidatesTokenCount") or 0) + (u.get("thoughtsTokenCount") or 0)


async def ask_gemini(client, model, key, system: str, messages: list[Message], usage: dict | None = None) -> str:
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
    _gemini_usage(data, usage)
    cand = (data.get("candidates") or [{}])[0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    if not text.strip():
        raise ProviderError("No text returned. The response may be blocked or its output limit exhausted.")
    return text.strip()


async def stream_gemini(client, model, key, system: str, messages: list[Message], usage: dict | None = None) -> AsyncIterator[str]:
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
    done = False
    async for data in events:
        ev = json.loads(data)
        _gemini_usage(ev, usage)
        cand = (ev.get("candidates") or [{}])[0]
        for p in (cand.get("content") or {}).get("parts") or []:
            if p.get("text") and not p.get("thought"):
                yield p["text"]
        if cand.get("finishReason"):  # the last chunk carries it, like non-streaming
            done = True
    if not done:
        raise ProviderError("stream ended without a finishReason; answer may be truncated")


# --------------------------------------------------------------------------
# Mock provider: lets you try the whole app with no API keys (TRIO_MOCK=1)
# --------------------------------------------------------------------------
def _mock_usage(usage: dict | None, messages: list[Message], text: str) -> None:
    if usage is not None:  # plausible fake numbers so the usage path is testable offline
        usage["input"] = 100 + len(messages[-1]["content"]) // 4
        usage["output"] = max(1, len(text) // 4)


def _mock(label: str):
    async def ask(client, model, key, system: str, messages: list[Message], usage: dict | None = None) -> str:
        await asyncio.sleep(0.4 + random.random() * 1.2)
        q = messages[-1]["content"]
        if "final answer" in system.lower():
            text = f"**Mock final answer** written by {label}, combining all three drafts."
        elif "review" in system.lower():
            text = f"- {label} mock review: Response A is strongest; B misses a caveat."
        else:
            text = f"Mock draft from **{label}** for: _{q[:80]}_"
        _mock_usage(usage, messages, text)
        return text
    return ask


def _mock_stream(label: str):
    async def stream(client, model, key, system: str, messages: list[Message], usage: dict | None = None) -> AsyncIterator[str]:
        if "final answer" in system.lower():
            text = f"**Mock final answer** streamed by {label}, combining all three drafts."
        else:
            q = messages[-1]["content"]
            text = f"Mock streamed draft from **{label}** for: _{q[:60]}_"
        _mock_usage(usage, messages, text)
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

    async def ask(self, client: httpx.AsyncClient, system: str, messages: list[Message],
                  usage: dict | None = None) -> str:
        return await self.fn(client, self.model, self.api_key, system, messages, usage)

    def stream(self, client: httpx.AsyncClient, system: str, messages: list[Message],
               usage: dict | None = None) -> AsyncIterator[str]:
        return self.stream_fn(client, self.model, self.api_key, system, messages, usage)


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
