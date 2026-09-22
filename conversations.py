"""SQLite conversation storage. IDs are bearer capabilities, never enumerable."""
from __future__ import annotations

import json
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32}$")


class ConversationConflict(Exception):
    """The conversation changed after the caller loaded it."""


class ConversationStore:
    def __init__(self, path: str):
        self.path = path

    def initialize(self) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS conversations "
                       "(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, "
                       "updated_at TEXT NOT NULL, turns TEXT NOT NULL)")

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, conversation_id: str) -> dict | None:
        if not ID_PATTERN.fullmatch(conversation_id):
            return None
        with self._connect() as db:
            row = db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if row is None:
            return None
        return {**dict(row), "turns": json.loads(row["turns"])}

    def delete(self, conversation_id: str) -> bool:
        """Remove a conversation for good; True when a row was actually deleted."""
        if not ID_PATTERN.fullmatch(conversation_id):
            return False
        with self._connect() as db:
            cur = db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
        return cur.rowcount > 0

    def append(self, conversation_id: str | None, turn: dict, expected_turns: int) -> dict:
        """Atomically append, rejecting stale continuations instead of losing turns."""
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if conversation_id:
                row = db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
                if row is None:
                    raise ConversationConflict("Conversation no longer exists.")
                turns = json.loads(row["turns"])
                if len(turns) != expected_turns:
                    raise ConversationConflict("Conversation changed in another tab. Reload before continuing.")
                turns.append(turn)
                db.execute("UPDATE conversations SET turns = ?, updated_at = ? WHERE id = ?",
                           (json.dumps(turns), now, conversation_id))
                created = row["created_at"]
            else:
                conversation_id = secrets.token_urlsafe(24)
                turns, created = [turn], now
                db.execute("INSERT INTO conversations VALUES (?, ?, ?, ?)",
                           (conversation_id, created, now, json.dumps(turns)))
        return {"id": conversation_id, "created_at": created, "updated_at": now, "turn_count": len(turns)}


def collect_event(out: dict, event: dict) -> None:
    """Collect terminal events only; partial/restarted streams are never saved."""
    kind = event["type"]
    if kind == "start":
        out["models"] = event["models"]
    elif kind in ("draft", "review"):
        if event.get("text"):
            out["drafts" if kind == "draft" else "reviews"][event["model"]] = event["text"]
        else:
            out["errors"][f"{event['model']}:{kind}"] = event.get("error")
    elif kind == "final":
        out.update({k: v for k, v in event.items() if k not in ("type", "text", "by")})
        out.update(answer=event["text"], written_by=event["by"])
    elif kind == "error":
        out["error"] = event["message"]


def recent_history(conversation: dict) -> list[dict]:
    return [message for turn in conversation["turns"][-20:]
            for message in ({"role": "user", "content": turn["question"][:60000]},
                            {"role": "assistant", "content": turn["result"]["answer"][:60000]})]
