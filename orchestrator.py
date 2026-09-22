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

from providers import Provider, active_providers, estimate_cost

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


def _synth_order(providers: list[Provider], succeeded: set[str], preferred: str | None = None) -> list[Provider]:
    """Preferred synthesiser first, then the rest; models whose draft failed go last."""
    preferred = preferred or os.getenv("SYNTHESIZER", "claude").lower()
    return sorted(providers, key=lambda p: (p.key not in succeeded, p.key != preferred))


def _new_totals() -> dict:
    return {"models": {}, "incomplete": False}


def _tally(totals: dict, key: str, u: dict, lost_stream: bool = False) -> None:
    """Add one call's token usage to a model's running total.

    lost_stream=True means a stream failed before its usage frame arrived.
    The request may have been accepted and billed even when no delta was
    seen, so this attempt's tokens are potentially missing: the totals are
    an undercount and must never be presented as a complete bill.
    """
    if u:
        t = totals["models"].setdefault(key, {"input": 0, "output": 0})
        t["input"] += u.get("input", 0)
        t["output"] += u.get("output", 0)
    if lost_stream and "output" not in u:
        totals["incomplete"] = True


def _usage_summary(providers: list[Provider], totals: dict) -> dict | None:
    """Per-model and total tokens, with estimated USD when every model is priced.

    An incomplete tally (a billed attempt whose usage was lost) reports
    cost as null - an understated total presented as exact would be worse
    than no total.
    """
    if not totals["models"]:
        return None
    model_of = {p.key: p.model for p in providers}
    models = {k: dict(v) for k, v in totals["models"].items()}
    cost, cost_known = 0.0, True
    for k, v in models.items():
        c = estimate_cost(model_of.get(k, ""), v["input"], v["output"])
        if c is None:
            cost_known = False
        elif totals["incomplete"]:
            pass  # undercounted tokens: a per-model price would also read as exact
        else:
            v["cost"] = round(c, 4)
            cost += c
    return {
        "models": models,
        "input": sum(v["input"] for v in models.values()),
        "output": sum(v["output"] for v in models.values()),
        "cost": round(cost, 4) if cost_known and not totals["incomplete"] else None,
        "incomplete": totals["incomplete"],
    }


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


async def _draft_one(client: httpx.AsyncClient, p: Provider, convo: list[dict],
                     queue: asyncio.Queue, totals: dict):
    """Draft with one model, streaming deltas onto the shared queue.

    Mirrors the synthesis rules: a stream that dies mid-answer re-emits
    draft_start (the answer restarts from scratch) and retries without
    streaming; only the terminal draft event decides success or failure.
    """
    t0 = time.monotonic()
    text, emitted, stream_failed = "", False, False
    if p.stream_fn:
        u: dict = {}
        await queue.put({"type": "draft_start", "model": p.key})
        try:
            async for piece in p.stream(client, DRAFT_SYSTEM, convo, u):
                text += piece
                emitted = True
                await queue.put({"type": "draft_delta", "model": p.key, "text": piece})
        except Exception:
            text, stream_failed = "", True  # cut mid-thought; retry below without streaming
        _tally(totals, p.key, u, lost_stream=stream_failed)
    text, err = text.strip(), None
    if not text:
        if emitted:
            await queue.put({"type": "draft_start", "model": p.key})
        u = {}
        try:
            text = await p.ask(client, DRAFT_SYSTEM, convo, u)
        except Exception as e:
            err = str(e) or e.__class__.__name__
        _tally(totals, p.key, u)
    await queue.put({"type": "draft", "model": p.key, "text": text or None, "error": err,
                     "seconds": round(time.monotonic() - t0, 1)})


async def run(
    client: httpx.AsyncClient,
    question: str,
    history: list[dict] | None = None,
    thorough: bool = True,
    model_keys: list[str] | None = None,
    synthesizer: str | None = None,
) -> AsyncIterator[dict]:
    t_start = time.monotonic()
    providers = active_providers()
    if model_keys is not None:
        providers = [provider for provider in providers if provider.key in model_keys]
    if not providers:
        yield {"type": "error", "message": "No API keys are set. Add at least one key to .env and restart."}
        return

    convo = [*(history or []), {"role": "user", "content": question}]
    yield {
        "type": "start",
        "thorough": thorough and len(providers) > 1,
        "models": [{"key": p.key, "label": p.label, "model": p.model} for p in providers],
        "synthesizer": synthesizer or os.getenv("SYNTHESIZER", "claude").lower(),
    }

    # ---- 1. Draft -------------------------------------------------------
    drafts: dict[str, str] = {}
    usage_totals = _new_totals()
    queue: asyncio.Queue = asyncio.Queue()
    tasks = [asyncio.create_task(_draft_one(client, p, convo, queue, usage_totals)) for p in providers]
    pending = len(tasks)
    try:
        while pending:
            ev = await queue.get()
            if ev["type"] == "draft":
                pending -= 1
                if ev["text"]:
                    drafts[ev["model"]] = ev["text"]
            yield ev
    finally:
        for t in tasks:  # client disconnected: stop paying for unfinished calls
            t.cancel()

    if not drafts:
        yield {"type": "error", "message": "All three models failed. Check your API keys and model names in .env."}
        return

    if len(drafts) == 1:
        (only_key, only_text), = drafts.items()
        yield {"type": "final", "text": only_text, "by": only_key,
               "usage": _usage_summary(providers, usage_totals),
               "seconds": round(time.monotonic() - t_start, 1)}
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
        review_usage: dict[str, dict] = {p.key: {} for p in reviewers}
        jobs = (_timed(p, p.ask(client, REVIEW_SYSTEM, [{"role": "user", "content": context}],
                                review_usage[p.key])) for p in reviewers)
        async for p, text, err, secs in _fan_out(jobs):
            _tally(usage_totals, p.key, review_usage[p.key])
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
    for p in _synth_order(providers, set(drafts), synthesizer):
        streamed = ""
        emitted = False
        stream_failed = False
        if p.stream_fn:
            u: dict = {}
            yield {"type": "final_start", "by": p.key}
            try:
                async for piece in p.stream(client, FINAL_SYSTEM, final_msgs, u):
                    streamed += piece
                    emitted = True
                    yield {"type": "final_delta", "by": p.key, "text": piece}
            except Exception as e:
                last_err = str(e) or e.__class__.__name__
                streamed = ""  # a broken stream may be cut mid-thought; retry below without streaming
                stream_failed = True
            _tally(usage_totals, p.key, u, lost_stream=stream_failed)
        text = streamed.strip()
        if not text:
            if emitted:
                # Consumers already showed deltas of an answer we are abandoning;
                # a fresh final_start tells them the answer restarts from scratch.
                yield {"type": "final_start", "by": p.key}
            u = {}
            _, full, err, _ = await _timed(p, p.ask(client, FINAL_SYSTEM, final_msgs, u))
            _tally(usage_totals, p.key, u)
            if err:
                last_err = err
            text = (full or "").strip()
        if text:
            yield {
                "type": "final", "text": text, "by": p.key,
                "letters": letters, "usage": _usage_summary(providers, usage_totals),
                "seconds": round(time.monotonic() - t_start, 1),
            }
            return

    # Every synthesiser failed: fall back to the longest draft rather than nothing.
    best = max(drafts, key=lambda k: len(drafts[k]))
    yield {
        "type": "final", "text": drafts[best], "by": best, "fallback": True,
        "note": f"Could not combine the answers ({last_err}). Showing the most complete single answer.",
        "usage": _usage_summary(providers, usage_totals),
        "seconds": round(time.monotonic() - t_start, 1),
    }
