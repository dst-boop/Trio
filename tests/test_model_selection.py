"""Per-question participation and synthesizer preferences, without paid calls."""
import os
from pathlib import Path
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('TRIO_MOCK', '1')
    monkeypatch.delenv('APP_PASSWORD', raising=False)
    with TestClient(main.app) as c:
        yield c


def test_subset_and_synthesizer_are_honored_and_saved(client, monkeypatch):
    monkeypatch.setenv('SYNTHESIZER', 'claude')
    out = client.post('/api/ask', json={'question': 'Choose two', 'models': ['claude', 'gemini'],
                     'synthesizer': 'gemini', 'stream': False}).json()
    assert set(out['drafts']) == {'claude', 'gemini'}
    assert set(out['reviews']) == {'claude', 'gemini'}
    assert out['written_by'] == 'gemini'
    assert {model['key'] for model in out['models']} == {'claude', 'gemini'}
    saved = client.get('/api/conversations/' + out['conversation_id']).json()['turns'][0]['result']
    assert saved['synthesizer'] == 'gemini'
    assert {model['key'] for model in saved['models']} == {'claude', 'gemini'}


def test_single_model_short_circuits_review_and_synthesis(client):
    out = client.post('/api/ask', json={'question': 'One model', 'models': ['openai'], 'stream': False}).json()
    assert set(out['drafts']) == {'openai'}
    assert out['reviews'] == {}
    assert out['answer'] == out['drafts']['openai']
    assert out['written_by'] == 'openai'


@pytest.mark.parametrize('options', [
    {'models': ['unknown']}, {'models': []}, {'models': ['claude', 'claude']},
    {'models': ['claude'], 'synthesizer': 'gemini'}, {'synthesizer': 'unknown'},
])
def test_invalid_selections_are_rejected(client, options):
    assert client.post('/api/ask', json={'question': 'q', **options}).status_code == 422


def test_unconfigured_selection_is_rejected_before_network(client, monkeypatch):
    monkeypatch.delenv('TRIO_MOCK')
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    assert client.post('/api/ask', json={'question': 'q', 'models': ['gemini']}).status_code == 422


def test_cli_selection_and_invalid_flags():
    directory = Path(__file__).resolve().parents[1]
    env = {**os.environ, 'TRIO_MOCK': '1'}
    selected = subprocess.run([sys.executable, 'cli.py', '--models', 'gemini', '--synthesizer', 'gemini', 'CLI question'],
                              cwd=directory, env=env, text=True, capture_output=True, timeout=20)
    assert selected.returncode == 0
    assert 'Asking Gemini' in selected.stderr
    assert 'Mock streamed draft' in selected.stdout
    bad = subprocess.run([sys.executable, 'cli.py', '--models', 'claude', '--synthesizer', 'gemini', 'q'],
                         cwd=directory, env=env, text=True, capture_output=True, timeout=20)
    assert bad.returncode == 2
    assert 'must be one of the selected' in bad.stderr
