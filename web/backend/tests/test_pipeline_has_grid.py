"""Verify Track API includes has_grid field in responses."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


def test_has_grid_false_when_no_grid(tmp_path):
    """Test that has_grid field is False when grid.json doesn't exist."""
    from app.config import settings
    from app.services.tracks import Track

    # Create a minimal track without grid.json
    tracks_dir = Path(settings.upload_dir) / '_tracks'
    tdir = tracks_dir / 'test_nogrid'
    tdir.mkdir(parents=True, exist_ok=True)
    (tdir / 'stems').mkdir(exist_ok=True)

    track = Track(
        id='test_nogrid',
        name='Test Track',
        created_at=0.0,
        stems={},
    )
    track.save()

    # Verify grid.json does not exist
    assert not (tdir / 'grid.json').exists()

    # Load and check has_grid field
    from app.services.tracks import get_track_enriched
    data = get_track_enriched('test_nogrid')
    assert data is not None
    assert data.get('has_grid') is False


def test_has_grid_true_when_grid_present(tmp_path):
    """Test that has_grid field is True when grid.json exists."""
    from app.config import settings
    from app.services.tracks import Track

    # Create a minimal track with grid.json
    tracks_dir = Path(settings.upload_dir) / '_tracks'
    tdir = tracks_dir / 'test_withgrid'
    tdir.mkdir(parents=True, exist_ok=True)
    (tdir / 'stems').mkdir(exist_ok=True)

    track = Track(
        id='test_withgrid',
        name='Test Track',
        created_at=0.0,
        stems={},
    )
    track.save()

    # Create grid.json
    (tdir / 'grid.json').write_text('{"engine": "manual", "bpm": 120.0}')
    assert (tdir / 'grid.json').exists()

    # Load and check has_grid field
    from app.services.tracks import get_track_enriched
    data = get_track_enriched('test_withgrid')
    assert data is not None
    assert data.get('has_grid') is True
