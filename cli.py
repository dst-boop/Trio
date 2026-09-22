"""Ask Trio from the command line.

  python cli.py "your question"
  python cli.py --quick "your question"    # skip the peer-review round

Progress goes to stderr, the final answer to stdout, so you can pipe it:
  python cli.py "..." > answer.md
"""
from __future__ import annotations

import asyncio
import argparse
import os
import sys

import httpx

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from orchestrator import run
from providers import active_providers

NAMES = {"claude": "Claude", "openai": "ChatGPT", "gemini": "Gemini"}


def note(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


async def main() -> int:
    parser = argparse.ArgumentParser(description='Ask selected AI models to collaborate on a question.')
    parser.add_argument('--quick', action='store_true', help='Skip peer review')
    parser.add_argument('--models', help='Comma-separated subset: claude,openai,gemini')
    parser.add_argument('--synthesizer', choices=NAMES, help='Preferred final-answer model (must be selected)')
    parser.add_argument('question', nargs='+')
    args = parser.parse_args()
    selected = [key.strip() for key in args.models.split(',')] if args.models is not None else None
    configured = {provider.key for provider in active_providers()}
    if selected is not None and (not selected or len(set(selected)) != len(selected) or not set(selected) <= configured):
        parser.error('--models must contain unique configured model keys: claude,openai,gemini')
    if args.synthesizer and args.synthesizer not in (set(selected) if selected is not None else configured):
        parser.error('--synthesizer must be one of the selected, configured models')
    question = " ".join(args.question)
    exit_code = 1
    printed = 0  # final-answer chunks already written to stdout
    timeout = httpx.Timeout(float(os.getenv("MODEL_TIMEOUT_SECONDS", "240")), connect=10)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async for ev in run(client, question, thorough=not args.quick, model_keys=selected, synthesizer=args.synthesizer):
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
                note("Writing the final answer...\n")
            elif t == "final_start":
                if printed:  # an earlier stream broke off; this model starts the answer over
                    print("\n")
                    note(f"(That attempt broke off - {NAMES.get(ev['by'], ev['by'])} is starting over.)")
                    printed = 0
            elif t == "final_delta":
                print(ev["text"], end="", flush=True)
                printed += 1
            elif t == "final":
                if printed:
                    print(flush=True)
                else:
                    print(ev["text"])
                note(f"\nDone in {ev['seconds']}s (written by {NAMES.get(ev['by'], ev['by'])}).")
                u = ev.get("usage")
                if u:
                    cost = f" (~${u['cost']:.2f})" if u.get("cost") is not None else ""
                    plus = "+" if u.get("incomplete") else ""
                    note(f"Tokens: {u['input']:,}{plus} in / {u['output']:,}{plus} out{cost}")
                if ev.get("note"):
                    note(ev["note"])
                exit_code = 0
            elif t == "error":
                note(ev["message"])
    return exit_code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
