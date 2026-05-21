"""Endpoint tests for /api/generation-presets.

Covers built-in vs user-saved listing, the new stem-aware filter (so
drum-only presets surface only when the modal is open on a drum row),
and save/delete protections.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.auth import require_auth


@pytest.fixture(autouse=True)
def _no_auth():
    """Override the require_auth dependency so TestClient calls succeed without a cookie."""
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Point the user-presets file at a fresh tmp dir so tests don't touch
    the real generation_presets.json."""
    from app import config
    monkeypatch.setattr(config.settings, 'upload_dir', str(tmp_path))
    return TestClient(app)


def _names(presets: list[dict]) -> set[str]:
    return {p['name'] for p in presets}


def test_list_returns_all_builtins_when_unfiltered(client: TestClient):
    r = client.get('/api/generation-presets')
    assert r.status_code == 200
    names = _names(r.json())
    assert 'v1' in names
    assert 'drums-v1' in names


def test_drums_filter_includes_universal_and_drum_presets(client: TestClient):
    r = client.get('/api/generation-presets?stem=drums')
    assert r.status_code == 200
    names = _names(r.json())
    assert 'v1' in names              # universal preset, always included
    assert 'drums-v1' in names        # explicitly stems=['drums']


def test_guitar_filter_excludes_drum_only_presets(client: TestClient):
    r = client.get('/api/generation-presets?stem=guitar')
    assert r.status_code == 200
    names = _names(r.json())
    assert 'v1' in names
    assert 'drums-v1' not in names    # stems=['drums'] excludes guitar


def test_bogus_stem_returns_only_universal_presets(client: TestClient):
    r = client.get('/api/generation-presets?stem=accordion')
    assert r.status_code == 200
    names = _names(r.json())
    assert 'v1' in names
    assert 'drums-v1' not in names


def test_drums_v1_uses_centroid_pitch_engine(client: TestClient):
    r = client.get('/api/generation-presets?stem=drums')
    drums_v1 = next(p for p in r.json() if p['name'] == 'drums-v1')
    assert drums_v1['stems'] == ['drums']
    gen = drums_v1['generation']
    assert gen['onsets']['engine'] == 'librosa-onset'
    assert gen['pitches']['engine'] == 'centroid'
    assert gen['quantized']['engine'] == 'metric-weighted'
    assert gen['lanes_expert']['engine'] == 'section-sliding'
    assert gen['lanes_expert']['params'].get('chord_polyphony_threshold') == 6
    assert gen['lanes_filtered']['engine'] == 'identity'


def test_user_saved_preset_appears_in_all_filtered_lists(client: TestClient):
    """User-saved presets don't carry a `stems` field, so they're universal."""
    save = client.post('/api/generation-presets', json={
        'name': 'my-test-preset',
        'description': 'test',
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    })
    assert save.status_code == 200
    assert 'stems' not in save.json()  # user-saved presets never carry a stems field

    for stem in ('drums', 'guitar', 'bass'):
        r = client.get(f'/api/generation-presets?stem={stem}')
        assert 'my-test-preset' in _names(r.json()), f'missing from {stem} filter'


def test_cannot_overwrite_builtin_drums_v1(client: TestClient):
    r = client.post('/api/generation-presets', json={
        'name': 'drums-v1',
        'description': 'attempt to overwrite',
        'generation': {
            'onsets': {'engine': 'librosa-onset', 'params': {}},
            'pitches': {'engine': 'yin', 'params': {}},
            'quantized': {'engine': 'metric-weighted', 'params': {}},
            'lanes_expert': {'engine': 'section-sliding', 'params': {}},
            'lanes_filtered': {'engine': 'identity', 'params': {}},
        },
    })
    assert r.status_code == 409
