"""The pipeline that makes three models work as one.

  1. Draft      - every model answers the question independently, in parallel.
  2. Review     - every model reads all drafts (anonymised as A/B/C so nobody
                  favours its own) and flags errors, gaps and disagreements.
  3. Synthesis  - one model writes the final answer from the drafts + reviews.

`run()` is an async generator of plain dict events, so the same code drives
the streaming web UI, the JSON API and the command line.
"""
from __future__ import annotations

import asyncio
import os
import random
import time
from typing import AsyncIterator

import httpx

from providers import Provider, active_providers

DRAFT_SYSTEM = (
    "You are one of three expert AI models independently answering the same question. "
    "Give your best, complete, accurate answer. Be direct and concrete. "
    "State real uncertainty plainly rather than guessing."
)

REVIEW_SYSTEM = (
    "You are a rigorous reviewer. You will review several anonymous candidate responses "
    "to a user's question. Be specific and brief (under 250 words). Identify: "
    "(1) factual or reasoning errors, naming the response; "
    "(2) points where the responses disagree, and which side is right and why; "
    "(3) anything important that every response missed; "
    "(4) which response is strongest overall."
)

FINAL_SYSTEM = (
    "You are writing the final answer for the user. You have the user's question, several "
    "independent draft responses, and peer reviews of those drafts. Write the single best "
    "possible answer: keep what is correct and most useful, fix every error the reviews "
    "identified, and resolve disagreements using the strongest reasoning. If a factual "
    "disagreement cannot be resolved, say so briefly and explain what it depends on. "
    "Reply to the user directly. Do not mention the drafts, the reviewers, or this process."
)


def _synth_order(providers: list[Provider], succeeded: set[str]) -> list[Provider]:
    """Preferred synthesiser first, then the rest; models whose draft failed go last."""
    preferred = os.getenv("SYNTHESIZER", "claude").lower()
    return sorted(providers, key=lambda p: (p.key not in succeeded, p.key != preferred))


async def _timed(p: Provider, coro):
    t0 = time.monotonic()
    try:
        return p, await coro, None, round(time.monotonic() - t0, 1)
    except Exception as e:  # one model failing must never sink the whole run
        return p, None, str(e) or e.__class__.__name__, round(time.monotonic() - t0, 1)


async def _fan_out(jobs):
    """Run jobs in parallel and yield each result as soon as it lands."""
    tasks = [asyncio.create_task(j) for j in jobs]
    try:
        for fut in asyncio.as_completed(tasks):
            yield await fut
    finally:
        for t in tasks:  # client disconnected: stop paying for unfinished calls
            t.cancel()


async def run(
    client: httpx.AsyncClient,
    question: str,
    history: list[dict] | None = None,
    thorough: bool = True,
) -> AsyncIterator[dict]:
    t_start = time.monotonic()
    providers = active_providers()
    if not providers:
        yield {"type": "error", "message": "No API keys are set. Add at least one key to .env and restart."}
        return

    convo = [*(history or []), {"role": "user", "content": question}]
    yield {
        "type": "start",
        "thorough": thorough and len(providers) > 1,
        "models": [{"key": p.key, "label": p.label, "model": p.model} for p in providers],
    }

    # ---- 1. Draft -------------------------------------------------------
    drafts: dict[str, str] = {}
    async for p, text, err, secs in _fan_out(_timed(p, p.ask(client, DRAFT_SYSTEM, convo)) for p in providers):
        if text:
            drafts[p.key] = text
        yield {"type": "draft", "model": p.key, "text": text, "error": err, "seconds": secs}

    if not drafts:
        yield {"type": "error", "message": "All three models failed. Check your API keys and model names in .env."}
        return

    if len(drafts) == 1:
        (only_key, only_text), = drafts.items()
        yield {"type": "final", "text": only_text, "by": only_key, "seconds": round(time.monotonic() - t_start, 1)}
        return

    # Anonymise drafts as Response A/B/C in random order.
    order = list(drafts)
    random.shuffle(order)
    letters = {k: chr(65 + i) for i, k in enumerate(order)}
    bundle = "\n\n".join(f"### Response {letters[k]}\n{drafts[k]}" for k in order)
    context = f"## User's question\n{question}\n\n## Candidate responses\n{bundle}"
    if history:
        recent = "\n".join(f"{m['role']}: {m['content'][:1500]}" for m in history[-6:])
        context = f"## Earlier conversation\n{recent}\n\n{context}"

    # ---- 2. Peer review -------------------------------------------------
    reviews: dict[str, str] = {}
    if thorough:
        reviewers = [p for p in providers if p.key in drafts]
        yield {"type": "stage", "stage": "review"}
        jobs = (_timed(p, p.ask(client, REVIEW_SYSTEM, [{"role": "user", "content": context}])) for p in reviewers)
        async for p, text, err, secs in _fan_out(jobs):
            if text:
                reviews[p.key] = text
            yield {"type": "review", "model": p.key, "text": text, "error": err, "seconds": secs}

    # ---- 3. Synthesis ---------------------------------------------------
    yield {"type": "stage", "stage": "final"}
    prompt = context
    if reviews:
        prompt += "\n\n## Peer reviews\n" + "\n\n".join(
            f"### Reviewer {i + 1}\n{r}" for i, r in enumerate(reviews.values())
        )
    prompt += "\n\nNow write the final answer to the user's question."

    final_msgs = [{"role": "user", "content": prompt}]
    last_err = None
    for p in _synth_order(providers, set(drafts)):
        streamed = ""
        if p.stream_fn:
            yield {"type": "final_start", "by": p.key}
            try:
                async for piece in p.stream(client, FINAL_SYSTEM, final_msgs):
                    streamed += piece
                    yield {"type": "final_delta", "by": p.key, "text": piece}
            except Exception as e:
                last_err = str(e) or e.__class__.__name__
                streamed = ""  # a broken stream may be cut mid-thought; retry below without streaming
        text = streamed.strip()
        if not text:
            _, full, err, _ = await _timed(p, p.ask(client, FINAL_SYSTEM, final_msgs))
            if err:
                last_err = err
            text = (full or "").strip()
        if text:
            yield {
                "type": "final", "text": text, "by": p.key,
                "letters": letters, "seconds": round(time.monotonic() - t_start, 1),
            }
            return

    # Every synthesiser failed: fall back to the longest draft rather than nothing.
    best = max(drafts, key=lambda k: len(drafts[k]))
    yield {
        "type": "final", "text": drafts[best], "by": best, "fallback": True,
        "note": f"Could not combine the answers ({last_err}). Showing the most complete single answer.",
        "seconds": round(time.monotonic() - t_start, 1),
    }


async def run_to_completion(client, question, history=None, thorough=True) -> dict:
    """Non-streaming helper: collect every event into one JSON-friendly dict."""
    out: dict = {"drafts": {}, "reviews": {}, "errors": {}}
    async for ev in run(client, question, history, thorough):
        t = ev["type"]
        if t in ("draft", "review"):
            bucket = out["drafts"] if t == "draft" else out["reviews"]
            if ev["text"]:
                bucket[ev["model"]] = ev["text"]
            else:
                out["errors"][f"{ev['model']}:{t}"] = ev["error"]
        elif t == "final":
            out.update(answer=ev["text"], written_by=ev["by"], seconds=ev["seconds"], note=ev.get("note"))
        elif t == "error":
            out["error"] = ev["message"]
    return out
