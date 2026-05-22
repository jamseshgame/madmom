"""Unit tests for order_beatmaps_for_publish — the pure helper that
chooses each stem's primary beatmap (stem_overrides override > active flag
> most recent) and orders the rest alphabetically by preset name for the
multi-beatmap publish flow.
"""
from __future__ import annotations

from app.routers.tracks import order_beatmaps_for_publish


def _bm(bid: str, stem: str, preset: str, *, active: bool = False,
        generated_at: float = 0.0, included: bool | None = None) -> dict:
    rec: dict = {
        'id': bid, 'stem': stem, 'preset': preset,
        'active': active, 'generated_at': generated_at,
    }
    if included is not None:
        rec['included'] = included
    return rec


def test_single_beatmap_per_stem_keeps_it_as_primary():
    bms = [_bm('g1', 'guitar', 'v1', active=True)]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    assert ordered == [(_bm('g1', 'guitar', 'v1', active=True), True)]


def test_included_false_excludes_beatmap_from_publish():
    bms = [
        _bm('g1', 'guitar', 'v1', active=False, generated_at=100.0, included=True),
        _bm('g2', 'guitar', 'v2', active=True,  generated_at=200.0, included=False),
        _bm('g3', 'guitar', 'v3', active=False, generated_at=300.0, included=True),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    # g2 is unchecked (included=False) and dropped entirely. The active flag
    # would have picked it as primary, so the picker falls back to most-recent
    # included (g3 at generated_at=300.0).
    assert [b['id'] for b, _ in ordered] == ['g3', 'g1']
    assert [is_primary for _, is_primary in ordered] == [True, False]


def test_missing_included_field_treated_as_included():
    """Backward-compat: pre-checkbox beatmap records don't have an `included`
    field. They should ship in publishes by default."""
    bms = [_bm('g1', 'guitar', 'v1', active=True)]  # no `included` key
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    assert len(ordered) == 1
    assert ordered[0][0]['id'] == 'g1'


def test_all_beatmaps_for_stem_excluded_drops_stem_entirely():
    bms = [
        _bm('g1', 'guitar', 'v1', active=True, included=False),
        _bm('d1', 'drums',  'v1', active=True, included=True),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    # Guitar stem has zero included beatmaps and is dropped.
    assert [b['stem'] for b, _ in ordered] == ['drums']


def test_active_flag_picks_primary_when_multiple_present():
    bms = [
        _bm('g1', 'guitar', 'v1', active=False, generated_at=100.0),
        _bm('g2', 'guitar', 'v2', active=True, generated_at=200.0),
        _bm('g3', 'guitar', 'v3', active=False, generated_at=300.0),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    # First is the active beatmap (g2), rest alphabetical by preset (v1 < v3).
    assert [b['id'] for b, _ in ordered] == ['g2', 'g1', 'g3']
    assert [is_active for _, is_active in ordered] == [True, False, False]


def test_stem_overrides_beat_the_active_flag():
    bms = [
        _bm('g1', 'guitar', 'v1', active=True, generated_at=100.0),
        _bm('g2', 'guitar', 'v2', active=False, generated_at=200.0),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={'guitar': 'g2'})
    # Override wins — g2 is primary even though g1 is the active one.
    assert [b['id'] for b, _ in ordered] == ['g2', 'g1']
    assert [is_active for _, is_active in ordered] == [True, False]


def test_override_with_missing_beatmap_id_falls_back_to_active():
    """A stem_overrides entry pointing at a beatmap_id that no longer
    exists in the candidates list (e.g. user saved the selection then
    deleted the beatmap) cleanly falls back to the next-best primary."""
    bms = [
        _bm('g1', 'guitar', 'v1', active=False, generated_at=100.0),
        _bm('g2', 'guitar', 'v2', active=True, generated_at=200.0),  # active
        _bm('g3', 'guitar', 'v3', active=False, generated_at=300.0),
    ]
    ordered = order_beatmaps_for_publish(
        bms,
        stem_overrides={'guitar': 'g-deleted-long-ago'},
    )
    # Override beatmap doesn't exist — falls through to active (g2).
    # Then alternates alphabetical: v1 < v3.
    assert [b['id'] for b, _ in ordered] == ['g2', 'g1', 'g3']
    assert [is_active for _, is_active in ordered] == [True, False, False]


def test_most_recent_wins_when_no_active_and_no_override():
    bms = [
        _bm('g1', 'guitar', 'v1', generated_at=100.0),
        _bm('g2', 'guitar', 'v2', generated_at=300.0),  # most recent
        _bm('g3', 'guitar', 'v3', generated_at=200.0),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    assert [b['id'] for b, _ in ordered] == ['g2', 'g1', 'g3']


def test_multi_stem_emits_per_stem_ordering_grouped():
    bms = [
        _bm('g1', 'guitar', 'v3', active=True),
        _bm('g2', 'guitar', 'v1'),
        _bm('d1', 'drums', 'drums-v1', active=True),
        _bm('d2', 'drums', 'v1'),
        _bm('d3', 'drums', 'v2'),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    # Order: all-guitar (primary then alts) followed by all-drums (primary
    # then alts). Within stem: primary first, alternates alphabetical by preset.
    assert [b['id'] for b, _ in ordered] == ['g1', 'g2', 'd1', 'd2', 'd3']


def test_alternates_sorted_alphabetically_then_by_generated_at():
    """Two alternates with the same preset name (e.g. user generated v3 twice)
    fall back to generated_at as the tiebreaker."""
    bms = [
        _bm('g1', 'guitar', 'v1', active=True),
        _bm('g2', 'guitar', 'v3', generated_at=300.0),
        _bm('g3', 'guitar', 'v3', generated_at=100.0),  # earlier v3
        _bm('g4', 'guitar', 'v2'),
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    # v1 (active), v2, v3 earliest, v3 newest.
    assert [b['id'] for b, _ in ordered] == ['g1', 'g4', 'g3', 'g2']


def test_empty_beatmaps_returns_empty_list():
    assert order_beatmaps_for_publish([], stem_overrides={}) == []


def test_beatmaps_with_no_stem_field_are_skipped():
    """Beatmaps without a 'stem' field can't be merged — they belong to no
    instrument. Drop them silently."""
    bms = [
        _bm('g1', 'guitar', 'v1', active=True),
        {'id': 'x', 'preset': 'v2'},  # no stem
    ]
    ordered = order_beatmaps_for_publish(bms, stem_overrides={})
    assert [b['id'] for b, _ in ordered] == ['g1']
