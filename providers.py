"""Provider layer: one small async function per vendor.

Plain HTTPS calls (no vendor SDKs) so there is nothing to keep in sync
except the model names in your .env file.
"""
from __future__ import annotations

import asyncio
import os
import random
from dataclasses import dataclass
from typing import Awaitable, Callable

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


@dataclass
class Provider:
    key: str          # "claude" | "openai" | "gemini"
    label: str        # shown in the UI
    model: str
    api_key: str
    fn: Callable[..., Awaitable[str]]

    async def ask(self, client: httpx.AsyncClient, system: str, messages: list[Message]) -> str:
        return await self.fn(client, self.model, self.api_key, system, messages)


def active_providers() -> list[Provider]:
    """Providers that have an API key configured (all three in mock mode)."""
    mock = os.getenv("TRIO_MOCK") == "1"
    specs = [
        ("claude", "Claude", "ANTHROPIC_API_KEY", "CLAUDE_MODEL", "claude-opus-5", ask_claude),
        ("openai", "ChatGPT", "OPENAI_API_KEY", "OPENAI_MODEL", "gpt-6-astra", ask_openai),
        ("gemini", "Gemini", "GEMINI_API_KEY", "GEMINI_MODEL", "gemini-3.8-flash", ask_gemini),
    ]
    out = []
    for key, label, key_env, model_env, default_model, fn in specs:
        api_key = os.getenv(key_env, "").strip()
        if mock:
            out.append(Provider(key, label, "mock", "mock", _mock(label)))
        elif api_key:
            out.append(Provider(key, label, os.getenv(model_env, default_model), api_key, fn))
    return out
