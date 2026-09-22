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

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

try:  # optional: load .env when running locally
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from orchestrator import run, run_to_completion
from providers import active_providers

STATIC = Path(__file__).parent / "static"
# Each question fans out to ~7 model calls; cap how many run at once per instance.
RUN_SLOTS = asyncio.Semaphore(int(os.getenv("MAX_CONCURRENT_RUNS", "8")))


@asynccontextmanager
async def lifespan(app: FastAPI):
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
    history = [t.model_dump() for t in req.history]
    client = app.state.http

    if not req.stream:
        async with RUN_SLOTS:
            return JSONResponse(await run_to_completion(client, req.question, history, req.thorough))

    async def events():
        async with RUN_SLOTS:
            try:
                async for ev in run(client, req.question, history, req.thorough):
                    yield f"data: {json.dumps(ev)}\n\n"
            except Exception as e:  # never leave the browser hanging
                yield f"data: {json.dumps({'type': 'error', 'message': f'Server error: {e}'})}\n\n"
        yield "data: {\"type\": \"done\"}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
