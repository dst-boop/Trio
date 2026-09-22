"""Vendor diagnostics must never copy secrets into answers or saved records."""
import asyncio

import httpx
import pytest

from providers import ProviderError, _post, _sse, stream_claude, ask_claude, ask_openai, ask_gemini

SECRET = 'sk-fake-credential-must-never-appear'


@pytest.mark.parametrize('streaming', [False, True])
@pytest.mark.parametrize('body', [SECRET, '{"error":{"message":"' + SECRET + '"}}'])
def test_http_error_bodies_are_not_exposed(streaming, body):
    async def go():
        transport = httpx.MockTransport(lambda request: httpx.Response(401, text=body))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(ProviderError) as raised:
                if streaming:
                    _ = [chunk async for chunk in _sse(client, 'https://api.example.test', {}, {})]
                else:
                    await _post(client, 'https://api.example.test', {}, {})
            assert SECRET not in str(raised.value)
            assert '401' in str(raised.value)
            assert 'API key' in str(raised.value)
    asyncio.run(go())


def test_stream_error_events_are_not_exposed():
    async def go():
        body = 'data: {"type":"error","error":{"message":"' + SECRET + '"}}\n\n'
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body))) as client:
            with pytest.raises(ProviderError) as raised:
                _ = [chunk async for chunk in stream_claude(client, 'model', 'key', 'system', [])]
            assert SECRET not in str(raised.value)
    asyncio.run(go())


@pytest.mark.parametrize('provider,body', [
    (ask_claude, {'content': [], 'stop_reason': SECRET}),
    (ask_openai, {'choices': [{'message': {}, 'finish_reason': SECRET}]}),
    (ask_gemini, {'candidates': [{'finishReason': SECRET}]}),
])
def test_empty_response_metadata_is_not_exposed(provider, body):
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body))) as client:
            with pytest.raises(ProviderError) as raised:
                await provider(client, 'model', 'key', 'system', [])
            assert SECRET not in str(raised.value)
            assert 'No text returned' in str(raised.value)
    asyncio.run(go())
