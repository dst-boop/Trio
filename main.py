"""Trio web server.

  GET  /            the web app
  POST /api/ask     ask all three models  (stream=true -> Server-Sent Events)
  GET  /api/status  which models are configured
  GET  /healthz     health check for Cloud Run / Railway

Run locally:   uvicorn main:app --reload
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

try:  # optional: load .env when running locally
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from orchestrator import run
from providers import active_providers
from conversations import ConversationStore, ConversationConflict, collect_event, recent_history

STATIC = Path(__file__).parent / "static"
# Each question fans out to ~7 model calls; cap how many run at once per instance.
RUN_SLOTS = asyncio.Semaphore(int(os.getenv("MAX_CONCURRENT_RUNS", "8")))


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.conversations = ConversationStore(os.getenv("TRIO_DB", "./trio.db"))
    await asyncio.to_thread(app.state.conversations.initialize)
    # One shared connection pool for all outbound calls.
    app.state.http = httpx.AsyncClient(
        timeout=httpx.Timeout(float(os.getenv("MODEL_TIMEOUT_SECONDS", "240")), connect=10),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )
    yield
    await app.state.http.aclose()


app = FastAPI(title="Trio", lifespan=lifespan)


class Turn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=60_000)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=60_000)
    history: list[Turn] = Field(default_factory=list, max_length=40)
    thorough: bool = True   # False skips the peer-review round (faster, cheaper)
    stream: bool = True
    conversation_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{32}$")
    expected_turns: int | None = Field(default=None, ge=1)
    models: list[Literal['claude', 'openai', 'gemini']] | None = Field(default=None, min_length=1, max_length=3)
    synthesizer: Literal['claude', 'openai', 'gemini'] | None = None


def check_password(supplied: str | None) -> None:
    """If APP_PASSWORD is set, every API call must send it. Set it before deploying:
    anyone who can reach /api/ask is spending your API credits."""
    expected = os.getenv("APP_PASSWORD", "")
    if expected and not hmac.compare_digest((supplied or "").encode(), expected.encode()):
        raise HTTPException(401, "Wrong or missing password.")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/c/{conversation_id}")
async def conversation_page(conversation_id: str):
    # The shell contains no saved content. The password-gated API hydrates it.
    return FileResponse(STATIC / "index.html", headers={"Referrer-Policy": "no-referrer"})


@app.get("/api/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, x_app_password: str | None = Header(default=None)):
    check_password(x_app_password)
    saved = await asyncio.to_thread(app.state.conversations.get, conversation_id)
    if saved is None:
        raise HTTPException(404, "Conversation not found.")
    return JSONResponse(saved, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@app.delete("/api/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, x_app_password: str | None = Header(default=None)):
    check_password(x_app_password)  # holding the link is the authorization, same as reading
    deleted = await asyncio.to_thread(app.state.conversations.delete, conversation_id)
    if not deleted:
        raise HTTPException(404, "Conversation not found.")
    return {"deleted": True}


@app.get("/api/status")
async def status(x_app_password: str | None = Header(default=None)):
    check_password(x_app_password)
    return {
        "models": [{"key": p.key, "label": p.label, "model": p.model} for p in active_providers()],
        "synthesizer": os.getenv("SYNTHESIZER", "claude"),
        "mock": os.getenv("TRIO_MOCK") == "1",
    }


@app.post("/api/ask")
async def ask(req: AskRequest, x_app_password: str | None = Header(default=None)):
    check_password(x_app_password)
    configured = {provider.key for provider in active_providers()}
    if req.models is not None and (len(set(req.models)) != len(req.models) or not set(req.models) <= configured):
        raise HTTPException(422, "Choose unique models from the configured roster.")
    if req.synthesizer and req.synthesizer not in (set(req.models) if req.models is not None else configured):
        raise HTTPException(422, "The preferred synthesizer must be one of the selected, configured models.")
    history = [t.model_dump() for t in req.history]
    client = app.state.http
    expected_turns = 0
    if req.conversation_id:
        saved = await asyncio.to_thread(app.state.conversations.get, req.conversation_id)
        if saved is None:
            raise HTTPException(404, "Conversation not found.")
        expected_turns = len(saved["turns"])
        if req.expected_turns is not None and req.expected_turns != expected_turns:
            raise HTTPException(409, "Conversation changed in another tab. Reload before continuing.")
        history = recent_history(saved)

    async def saved_run():
        out = {"drafts": {}, "reviews": {}, "errors": {}}
        async for event in run(client, req.question, history, req.thorough, model_keys=req.models, synthesizer=req.synthesizer):
            collect_event(out, event)
            yield event
            if event["type"] == "final":
                try:
                    record = await asyncio.to_thread(app.state.conversations.append, req.conversation_id,
                                                     {"question": req.question, "thorough": req.thorough, "result": out},
                                                     expected_turns)
                    yield {"type": "saved", "conversation_id": record["id"], "turn_count": record["turn_count"]}
                except ConversationConflict as error:
                    yield {"type": "save_error", "message": str(error)}
                except Exception:
                    yield {"type": "save_error", "message": "Answer completed, but it could not be saved. Copy it before leaving this page."}

    if not req.stream:
        async with RUN_SLOTS:
            out = {"drafts": {}, "reviews": {}, "errors": {}}
            async for event in saved_run():
                collect_event(out, event)
                if event["type"] == "saved":
                    out.update(conversation_id=event["conversation_id"], turn_count=event["turn_count"])
                elif event["type"] == "save_error":
                    out["save_error"] = event["message"]
            return JSONResponse(out, headers={"Cache-Control": "no-store"})

    async def events():
        async with RUN_SLOTS:
            try:
                async for ev in saved_run():
                    yield f"data: {json.dumps(ev)}\n\n"
            except Exception:  # never leave the browser hanging or expose exception details
                yield f"data: {json.dumps({'type': 'error', 'message': 'Server error. Please try again.'})}\n\n"
        yield "data: {\"type\": \"done\"}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
