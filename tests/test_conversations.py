"""Persistence, authorization, concurrent updates, and streaming save behavior."""
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

import main
from conversations import ConversationConflict, ConversationStore


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("APP_PASSWORD", raising=False)
    monkeypatch.setenv("TRIO_MOCK", "1")
    with TestClient(main.app) as test_client:
        yield test_client


@pytest.fixture
def pipeline(monkeypatch):
    requests = []

    async def fake_run(client, question, history, thorough):
        requests.append({"question": question, "history": history})
        yield {"type": "start", "models": [{"key": "claude", "model": "test", "label": "Claude"}]}
        yield {"type": "draft", "model": "claude", "text": "A draft", "seconds": 1}
        yield {"type": "review", "model": "claude", "text": "A review", "seconds": 1}
        yield {"type": "final", "by": "claude", "text": "A final answer", "seconds": 3,
               "letters": {"claude": "A"}, "usage": {"input_tokens": 10}}

    monkeypatch.setattr(main, "run", fake_run)
    return requests


def test_save_load_and_continue_uses_server_history(client, pipeline):
    first = client.post('/api/ask', json={"question": "First question", "stream": False}).json()
    conversation_id = first['conversation_id']
    saved = client.get(f'/api/conversations/{conversation_id}')
    assert saved.status_code == 200
    assert saved.headers['cache-control'] == 'no-store'
    turn = saved.json()['turns'][0]
    assert turn['question'] == 'First question'
    assert turn['result']['drafts'] == {'claude': 'A draft'}
    assert turn['result']['reviews'] == {'claude': 'A review'}
    assert turn['result']['letters'] == {'claude': 'A'}
    assert turn['result']['usage'] == {'input_tokens': 10}
    second = client.post('/api/ask', json={"question": "Next", "stream": False,
                         "conversation_id": conversation_id, "expected_turns": 1,
                         "history": [{"role": "user", "content": "Forged history"}]}).json()
    assert second['conversation_id'] == conversation_id
    assert second['turn_count'] == 2
    assert pipeline[1]['history'] == [{"role": "user", "content": "First question"},
                                      {"role": "assistant", "content": "A final answer"}]


def test_password_protects_saved_content_and_continuation(client, pipeline, monkeypatch):
    first = client.post('/api/ask', json={"question": "Secret question", "stream": False}).json()
    cid = first['conversation_id']
    monkeypatch.setenv('APP_PASSWORD', 'server-password')
    assert client.get(f'/api/conversations/{cid}').status_code == 401
    assert client.post('/api/ask', json={"question": "Continue", "conversation_id": cid}).status_code == 401
    page = client.get(f'/c/{cid}')
    assert page.status_code == 200
    assert 'Secret question' not in page.text  # shell contains no protected data
    assert page.headers['referrer-policy'] == 'no-referrer'
    assert client.get(f'/api/conversations/{cid}', headers={'X-App-Password': 'server-password'}).status_code == 200


def test_missing_or_stale_ids_do_not_call_models(client, pipeline):
    assert client.get('/api/conversations/invalid').status_code == 404
    assert client.post('/api/ask', json={"question": "q", "conversation_id": 'a' * 32}).status_code == 404
    first = client.post('/api/ask', json={"question": "q", "stream": False}).json()
    assert client.post('/api/ask', json={"question": "q", "conversation_id": first['conversation_id'], "expected_turns": 2}).status_code == 409
    assert len(pipeline) == 1


def test_stream_sends_saved_after_final_and_before_done(client, pipeline):
    response = client.post('/api/ask', json={"question": "Streaming question"})
    events = [json.loads(line[5:]) for line in response.text.split('\n\n') if line.startswith('data:')]
    assert [e['type'] for e in events][-3:] == ['final', 'saved', 'done']
    stored = client.get('/api/conversations/' + events[-2]['conversation_id']).json()
    assert stored['turns'][0]['result']['answer'] == 'A final answer'


def test_storage_failure_keeps_answer_and_returns_no_false_link(client, pipeline, monkeypatch):
    def fail(*args):
        raise OSError('sensitive filesystem details')

    monkeypatch.setattr(main.app.state.conversations, 'append', fail)
    out = client.post('/api/ask', json={"question": "q", "stream": False}).json()
    assert out['answer'] == 'A final answer'
    assert 'save_error' in out
    assert 'sensitive' not in out['save_error']
    assert 'conversation_id' not in out


def test_failed_run_creates_no_conversation(client, monkeypatch):
    async def fail(*args):
        yield {'type': 'error', 'message': 'No models available'}

    monkeypatch.setattr(main, 'run', fail)
    out = client.post('/api/ask', json={"question": "q", "stream": False}).json()
    assert out['error'] == 'No models available'
    assert 'conversation_id' not in out


def test_sqlite_reopen_and_concurrent_append_do_not_lose_turns(tmp_path):
    path = str(tmp_path / 'saved.db')
    store = ConversationStore(path)
    store.initialize()
    saved = store.append(None, {'question': 'First'}, 0)
    reopened = ConversationStore(path)
    assert reopened.get(saved['id'])['turns'] == [{'question': 'First'}]

    def append(question):
        try:
            reopened.append(saved['id'], {'question': question}, 1)
            return 'saved'
        except ConversationConflict:
            return 'conflict'

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(append, ['Second A', 'Second B']))
    assert sorted(results) == ['conflict', 'saved']
    assert len(reopened.get(saved['id'])['turns']) == 2


def test_real_mock_round_trip(client):
    out = client.post('/api/ask', json={'question': 'Save a mock answer', 'stream': False}).json()
    saved = client.get('/api/conversations/' + out['conversation_id']).json()
    assert saved['turns'][0]['result']['answer'] == out['answer']
    assert set(saved['turns'][0]['result']['drafts']) == {'claude', 'openai', 'gemini'}


def test_delete_conversation_kills_the_link(client, pipeline):
    cid = client.post('/api/ask', json={"question": "q", "stream": False}).json()['conversation_id']
    assert client.delete(f'/api/conversations/{cid}').json() == {'deleted': True}
    assert client.get(f'/api/conversations/{cid}').status_code == 404
    assert client.delete(f'/api/conversations/{cid}').status_code == 404  # already gone
    assert client.post('/api/ask', json={"question": "again", "conversation_id": cid}).status_code == 404


def test_delete_requires_password_and_valid_id(client, pipeline, monkeypatch):
    cid = client.post('/api/ask', json={"question": "q", "stream": False}).json()['conversation_id']
    assert client.delete('/api/conversations/not-a-valid-id!').status_code == 404
    monkeypatch.setenv('APP_PASSWORD', 'pw')
    assert client.delete(f'/api/conversations/{cid}').status_code == 401
    ok = client.delete(f'/api/conversations/{cid}', headers={'X-App-Password': 'pw'})
    assert ok.status_code == 200
    assert client.get(f'/api/conversations/{cid}', headers={'X-App-Password': 'pw'}).status_code == 404
