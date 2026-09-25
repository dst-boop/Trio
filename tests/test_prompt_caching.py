"""Claude prompt caching: where the breakpoint goes, and what it does to the bill."""
import asyncio
import json

import httpx
import pytest

from providers import (
    CACHE_READ_RATE,
    CACHE_WRITE_RATE,
    PRICES,
    ask_claude,
    estimate_cost,
    stream_claude,
)

MODEL = "claude-opus-5"
ANSWER = {"content": [{"type": "text", "text": "answer"}],
          "usage": {"input_tokens": 10, "output_tokens": 5}}


def _capture(response):
    """A transport that records the request body it was given."""
    sent = {}

    def handler(request):
        sent.update(json.loads(request.content))
        return response

    return sent, httpx.MockTransport(handler)


def _ask(messages, response=None):
    sent, transport = _capture(response or httpx.Response(200, json=ANSWER))
    usage = {}

    async def go():
        async with httpx.AsyncClient(transport=transport) as client:
            await ask_claude(client, MODEL, "key", "system", messages, usage)

    asyncio.run(go())
    return sent, usage


def _cache_controls(body):
    """Every cache_control marker in a request body, by message index."""
    return {
        i: block["cache_control"]
        for i, m in enumerate(body["messages"])
        if isinstance(m["content"], list)
        for block in m["content"]
        if "cache_control" in block
    }


def test_first_question_is_not_cached():
    # Nothing has been sent before, so a cache entry could only be written,
    # never read - and a write costs more than plain input.
    sent, _ = _ask([{"role": "user", "content": "first question"}])
    assert sent["messages"] == [{"role": "user", "content": "first question"}]
    assert _cache_controls(sent) == {}


def test_thread_with_history_caches_through_the_current_question():
    messages = [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "follow-up"},
    ]
    sent, _ = _ask(messages)
    # One breakpoint, on the last message: the cached prefix is everything the
    # next turn will resend.
    assert _cache_controls(sent) == {2: {"type": "ephemeral"}}
    assert sent["messages"][2]["content"] == [
        {"type": "text", "text": "follow-up", "cache_control": {"type": "ephemeral"}}
    ]
    assert sent["messages"][:2] == messages[:2]  # earlier turns sent unchanged


def test_caching_never_mutates_the_shared_message_list():
    # The same list object is handed to all three providers drafting at once;
    # rewriting it in place would corrupt the OpenAI and Gemini requests.
    messages = [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "follow-up"},
    ]
    before = [dict(m) for m in messages]
    _ask(messages)
    assert messages == before


def test_streaming_places_the_same_breakpoint():
    frames = (
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'
        'data: {"type":"message_stop"}\n\n'
    )
    sent, transport = _capture(httpx.Response(200, text=frames))
    messages = [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "follow-up"},
    ]

    async def go():
        async with httpx.AsyncClient(transport=transport) as client:
            return [p async for p in stream_claude(client, MODEL, "key", "system", messages)]

    assert asyncio.run(go()) == ["hi"]
    assert _cache_controls(sent) == {2: {"type": "ephemeral"}}


@pytest.mark.parametrize("streaming", [False, True])
def test_cached_tokens_are_counted_as_input_and_reported_separately(streaming):
    # input_tokens from Anthropic excludes cached tokens. Reporting it raw would
    # show a thread getting cheaper by sending fewer tokens, which is not what
    # happened - the tokens were sent and billed, just at other rates.
    reported = {"input_tokens": 10, "cache_creation_input_tokens": 200,
                "cache_read_input_tokens": 800, "output_tokens": 5}
    usage = {}
    if streaming:
        frames = (
            'data: {"type":"message_start","message":{"usage":'
            + json.dumps(reported) + '}}\n\n'
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'
            'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'
            'data: {"type":"message_stop"}\n\n'
        )
        _, transport = _capture(httpx.Response(200, text=frames))

        async def go():
            async with httpx.AsyncClient(transport=transport) as client:
                async for _ in stream_claude(client, MODEL, "key", "s", [{"role": "user", "content": "q"}], usage):
                    pass

        asyncio.run(go())
    else:
        _, usage = _ask([{"role": "user", "content": "q"}],
                        httpx.Response(200, json={"content": [{"type": "text", "text": "a"}],
                                                  "usage": reported}))

    assert usage["input"] == 1010  # 10 uncached + 200 written + 800 read
    assert usage["cache_write"] == 200
    assert usage["cache_read"] == 800
    assert usage["output"] == 5


def test_uncached_calls_report_no_cache_fields():
    _, usage = _ask([{"role": "user", "content": "q"}])
    assert usage == {"input": 10, "output": 5}


def test_cache_reads_are_priced_below_plain_input():
    rate_in, rate_out = PRICES[MODEL]
    plain = estimate_cost(MODEL, 1000, 100)
    read = estimate_cost(MODEL, 1000, 100, cache_read=1000)
    written = estimate_cost(MODEL, 1000, 100, cache_write=1000)

    assert read == pytest.approx((1000 * rate_in * CACHE_READ_RATE + 100 * rate_out) / 1_000_000)
    assert written == pytest.approx((1000 * rate_in * CACHE_WRITE_RATE + 100 * rate_out) / 1_000_000)
    assert read < plain < written  # a read saves; a write costs a premium up front


def test_cost_is_unchanged_for_calls_without_caching():
    assert estimate_cost(MODEL, 1000, 100) == estimate_cost(MODEL, 1000, 100, 0, 0)


def test_unpriced_model_still_reports_no_cost():
    assert estimate_cost("mock", 1000, 100, cache_read=500) is None
