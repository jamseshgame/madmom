"""Endpoint tests for the separation-engine catalog surfaced at /api/stems/engines.

The frontend renders the whole settings panel off this payload, so its shape is
part of the contract rather than an implementation detail.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _bypass_auth():
    from app.main import app
    from app.routers.auth import require_auth
    app.dependency_overrides[require_auth] = lambda: None
    yield
    app.dependency_overrides.pop(require_auth, None)


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, 'upload_dir', str(tmp_path / 'uploads'))
    from app.main import app
    return TestClient(app)


class TestEnginesEndpoint:
    def test_returns_engines_defaults_and_model_lists(self, client):
        r = client.get('/api/stems/engines')
        assert r.status_code == 200
        body = r.json()

        assert body['default_engine'] == 'hybrid'
        assert [e['key'] for e in body['engines']] == ['hybrid', 'audio-separator', 'demucs']
        assert set(body['defaults']) == {'hybrid', 'audio-separator', 'demucs'}
        assert 'htdemucs_6s' in body['demucs_models']
        assert 'available' in body['audio_separator']

    def test_defaults_key_set_matches_each_engine_schema(self, client):
        body = client.get('/api/stems/engines').json()
        for engine in body['engines']:
            assert set(body['defaults'][engine['key']]) == {p['key'] for p in engine['params']}

    def test_every_engine_advertises_quality_and_speed(self, client):
        body = client.get('/api/stems/engines').json()
        for engine in body['engines']:
            assert engine['quality'] and engine['speed'] and engine['description']

    def test_model_catalog_endpoint_reports_availability(self, client):
        r = client.get('/api/stems/engines/models')
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {'available', 'models', 'error'}


class TestSeparateValidation:
    def _post(self, client, **form):
        return client.post(
            '/api/stems/separate',
            files={'file': ('song.wav', b'RIFFfake', 'audio/wav')},
            data=form,
        )

    def test_rejects_unknown_engine(self, client):
        r = self._post(client, engine='spleeter')
        assert r.status_code == 400
        assert 'Unknown engine' in r.json()['detail']

    def test_rejects_unsupported_extension(self, client):
        r = client.post(
            '/api/stems/separate',
            files={'file': ('song.txt', b'x', 'text/plain')},
            data={'engine': 'demucs'},
        )
        assert r.status_code == 400
        assert 'Unsupported format' in r.json()['detail']

    def test_rejects_non_json_params(self, client):
        r = self._post(client, engine='hybrid', params='not json')
        assert r.status_code == 400
        assert 'params must be a JSON object' in r.json()['detail']

    def test_rejects_json_that_is_not_an_object(self, client):
        r = self._post(client, engine='hybrid', params='[1, 2]')
        assert r.status_code == 400

    def test_rejects_unknown_demucs_model(self, client):
        r = self._post(client, engine='demucs', params='{"model": "htdemucs_99s"}')
        assert r.status_code == 400
        assert 'Unknown Demucs model' in r.json()['detail']

    def test_legacy_form_fields_still_seed_demucs_params(self, client, monkeypatch):
        """Older clients post shifts/overlap/model as flat fields, not `params`."""
        seen = {}

        async def fake_separate(**kwargs):
            seen.update(kwargs)
            return {'stems': {}, 'track_name': 'song', 'engine': 'demucs',
                    'model': 'htdemucs', 'output_format': 'wav', 'game_ready': False}

        monkeypatch.setattr('app.routers.stems.separate_with_engine', fake_separate)
        r = self._post(client, engine='demucs', model='htdemucs', shifts='4',
                       overlap='0.3', clip_mode='clamp', segment='12')
        assert r.status_code == 200
        assert 'job_id' in r.json()

    def test_explicit_params_win_over_legacy_fields(self, client, monkeypatch):
        seen = {}

        async def fake_separate(**kwargs):
            seen.update(kwargs)
            return {'stems': {}, 'track_name': 'song', 'engine': 'demucs',
                    'model': 'htdemucs_6s', 'output_format': 'wav', 'game_ready': False}

        monkeypatch.setattr('app.routers.stems.separate_with_engine', fake_separate)
        r = self._post(client, engine='demucs', shifts='4', params='{"shifts": 9}')
        assert r.status_code == 200
        # The job runs as a background task; give it a beat to start.
        import time
        for _ in range(50):
            if seen:
                break
            time.sleep(0.02)
        assert seen.get('params', {}).get('shifts') == 9
