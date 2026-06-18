"""Difficulty-calibration service: walk selected tracks' included beatmaps and
produce a flat metric row per song x instrument x difficulty, plus per-tier
summary stats. Read-only; never mutates charts."""
from __future__ import annotations

from .calibration_metrics import build_tempo_map, section_metrics, summarize_rows
from .chart_generator import _extract_section_body, _read_resolution, chart_difficulties
from .tracks import Track

DIFFICULTY_PREFIXES = ('Expert', 'Hard', 'Medium', 'Easy')

# Stem -> display instrument label (mirrors the frontend STEM_LABELS spirit).
_INSTRUMENT = {
    'guitar': 'Guitar', 'bass': 'Bass', 'rhythm': 'Rhythm', 'drums': 'Drums',
    'piano': 'Keys', 'vocals': 'Vocals', 'other': 'Other', 'song': 'Song',
}


def _difficulty_of(section: str) -> str | None:
    for p in DIFFICULTY_PREFIXES:
        if section.startswith(p):
            return p
    return None


def compute_calibration(track_ids: list[str]) -> dict:
    rows: list[dict] = []
    skipped: list[dict] = []

    for track_id in track_ids:
        track = Track.load(track_id)
        if not track:
            skipped.append({'track_id': track_id, 'beatmap_id': '', 'reason': 'track not found'})
            continue
        song_name = track.name
        artist = track.artist

        for bm in track.beatmaps:
            if not bm.get('included', True):
                continue
            beatmap_id = bm.get('id', '')
            stem = bm.get('stem', '')
            chart_path = track.beatmaps_dir / beatmap_id / 'notes.chart'
            if not chart_path.exists():
                skipped.append({'track_id': track_id, 'beatmap_id': beatmap_id, 'reason': 'no notes.chart'})
                continue
            try:
                text = chart_path.read_text(encoding='utf-8', errors='replace')
            except OSError as exc:
                skipped.append({'track_id': track_id, 'beatmap_id': beatmap_id, 'reason': f'read error: {exc}'})
                continue

            resolution = _read_resolution(text) or 192
            tempo_map = build_tempo_map(text)

            # rows produced for this single beatmap, so we can compute the
            # cross-difficulty ratio against its own Expert tier.
            bm_rows: list[dict] = []
            for diff in chart_difficulties(text):
                section = diff['name']
                difficulty = _difficulty_of(section)
                if difficulty is None:
                    continue
                body = _extract_section_body(text, section)
                if body is None:
                    continue
                metrics = section_metrics(body, resolution, tempo_map)
                if metrics is None:
                    continue
                row = {
                    'track_id': track_id,
                    'song_name': song_name,
                    'artist': artist,
                    'stem': stem,
                    'instrument': _INSTRUMENT.get(stem, stem.title() if stem else 'Unknown'),
                    'beatmap_id': beatmap_id,
                    'preset': bm.get('preset'),
                    'difficulty': difficulty,
                    'section': section,
                    'pct_of_expert_gpm': None,
                    **metrics,
                }
                bm_rows.append(row)

            # Cross-difficulty ratio anchored to this beatmap's Expert tier.
            expert = next((r for r in bm_rows if r['difficulty'] == 'Expert'), None)
            expert_gpm = expert['gems_per_min'] if expert else 0.0
            if expert_gpm > 0:
                for r in bm_rows:
                    r['pct_of_expert_gpm'] = round(100.0 * r['gems_per_min'] / expert_gpm, 1)
            rows.extend(bm_rows)

    return {'rows': rows, 'summary': summarize_rows(rows), 'skipped': skipped}
