"""Ask Trio from the command line.

  python cli.py "your question"
  python cli.py --quick "your question"    # skip the peer-review round

Progress goes to stderr, the final answer to stdout, so you can pipe it:
  python cli.py "..." > answer.md
"""
from __future__ import annotations

import asyncio
import os
import sys

import httpx

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from orchestrator import run

NAMES = {"claude": "Claude", "openai": "ChatGPT", "gemini": "Gemini"}


def note(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


async def main() -> int:
    args = sys.argv[1:]
    thorough = "--quick" not in args
    words = [a for a in args if not a.startswith("--")]
    if not words:
        note(__doc__.strip())
        return 2

    question = " ".join(words)
    exit_code = 1
    timeout = httpx.Timeout(float(os.getenv("MODEL_TIMEOUT_SECONDS", "240")), connect=10)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async for ev in run(client, question, thorough=thorough):
            t = ev["type"]
            if t == "start":
                note("Asking " + ", ".join(m["label"] for m in ev["models"]) + "...")
            elif t == "draft":
                who = NAMES.get(ev["model"], ev["model"])
                note(f"  {who} answered in {ev['seconds']}s" if ev["text"]
                     else f"  {who} failed: {ev['error']}")
            elif t == "stage" and ev["stage"] == "review":
                note("Reviewing one another's answers...")
            elif t == "review" and not ev["text"]:
                note(f"  {NAMES.get(ev['model'], ev['model'])}'s review failed: {ev['error']}")
            elif t == "stage" and ev["stage"] == "final":
                note("Writing the final answer...")
            elif t == "final":
                note(f"Done in {ev['seconds']}s (written by {NAMES.get(ev['by'], ev['by'])}).\n")
                if ev.get("note"):
                    note(ev["note"])
                print(ev["text"])
                exit_code = 0
            elif t == "error":
                note(ev["message"])
    return exit_code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
