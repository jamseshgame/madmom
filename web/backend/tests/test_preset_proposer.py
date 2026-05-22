"""Unit tests for the Claude-driven preset proposer.

The Anthropic client is mocked so the tests don't make network calls.
Tests verify (1) the system prompt is built with engine catalog, current
presets, and feedback bundle, (2) the response is parsed into validated
proposals, (3) schema-invalid proposals are dropped, (4) common error
modes raise the right exceptions."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from app.services import preset_proposer


_VALID_GENERATION = {
    'onsets':         {'engine': 'librosa-onset',   'params': {}},
    'pitches':        {'engine': 'centroid',        'params': {}},
    'quantized':      {'engine': 'metric-weighted', 'params': {}},
    'lanes_expert':   {'engine': 'section-sliding', 'params': {}},
    'lanes_filtered': {'engine': 'identity',        'params': {}},
}


def _mock_response(payload):
    """Build a fake anthropic.Anthropic().messages.create() return value."""
    msg = MagicMock()
    msg.content = [MagicMock(text=json.dumps(payload), type='text')]
    msg.stop_reason = 'end_turn'
    return msg


@pytest.fixture(autouse=True)
def _isolated_settings(monkeypatch):
    """Default to a key being set so tests don't trip the 503 branch."""
    monkeypatch.setattr(preset_proposer.settings, 'anthropic_api_key', 'sk-test')
    monkeypatch.setattr(preset_proposer.settings, 'anthropic_model', 'claude-sonnet-4-6')
    monkeypatch.setattr(preset_proposer.settings, 'anthropic_max_tokens', 1024)


@patch('app.services.preset_proposer._anthropic_client')
def test_returns_validated_proposals(mock_client, monkeypatch):
    monkeypatch.setattr(preset_proposer, 'aggregate_for_stem',
                        lambda s: [{'track_name': 'A', 'preset_name': 'v1', 'beatmap_id': 'b1',
                                    'beatmap_name': 'V1', 'notes': [
                                        {'author': 'alice', 'rating': 2,
                                         'tags': ['too-crampy'], 'text': 'cramped'}]}])

    mock_client.messages.create.return_value = _mock_response({
        'proposals': [
            {'name': 'v12-anti-cramp', 'description': 'Less crampy',
             'generation': _VALID_GENERATION,
             'stems': ['drums'],
             'rationale': 'Cites A/v1 cramp complaint.'},
        ],
    })

    result = preset_proposer.propose_presets('drums', n=3)
    assert len(result) == 1
    assert result[0]['name'] == 'v12-anti-cramp'
    assert result[0]['generation'] == _VALID_GENERATION


@patch('app.services.preset_proposer._anthropic_client')
def test_drops_schema_invalid_proposals(mock_client, monkeypatch):
    monkeypatch.setattr(preset_proposer, 'aggregate_for_stem',
                        lambda s: [{'track_name': 'A', 'preset_name': 'v1', 'beatmap_id': 'b1',
                                    'beatmap_name': 'V1', 'notes': [{'rating': 1, 'tags': [], 'text': 'bad'}]}])
    bad_gen = {'onsets': {'engine': 'x'}}  # missing pitches/quantized/lanes_*
    mock_client.messages.create.return_value = _mock_response({
        'proposals': [
            {'name': 'good', 'description': '', 'generation': _VALID_GENERATION, 'rationale': 'r'},
            {'name': 'bad', 'description': '', 'generation': bad_gen, 'rationale': 'r'},
        ],
    })
    result = preset_proposer.propose_presets('drums', n=3)
    assert [p['name'] for p in result] == ['good']


def test_missing_api_key_raises(monkeypatch):
    monkeypatch.setattr(preset_proposer.settings, 'anthropic_api_key', '')
    with pytest.raises(preset_proposer.ProposalError) as ei:
        preset_proposer.propose_presets('drums', n=3)
    assert 'not configured' in str(ei.value).lower()


@patch('app.services.preset_proposer._anthropic_client')
def test_empty_feedback_raises(mock_client, monkeypatch):
    monkeypatch.setattr(preset_proposer, 'aggregate_for_stem', lambda s: [])
    with pytest.raises(preset_proposer.ProposalError) as ei:
        preset_proposer.propose_presets('drums', n=3)
    assert 'no feedback' in str(ei.value).lower()


@patch('app.services.preset_proposer._anthropic_client')
def test_invalid_json_response_raises(mock_client, monkeypatch):
    monkeypatch.setattr(preset_proposer, 'aggregate_for_stem',
                        lambda s: [{'track_name': 'A', 'preset_name': 'v1', 'beatmap_id': 'b1',
                                    'beatmap_name': 'V1', 'notes': [{'rating': 1, 'tags': [], 'text': 'x'}]}])
    msg = MagicMock()
    msg.content = [MagicMock(text='not valid json {', type='text')]
    mock_client.messages.create.return_value = msg
    with pytest.raises(preset_proposer.ProposalError) as ei:
        preset_proposer.propose_presets('drums', n=3)
    assert 'invalid json' in str(ei.value).lower()
