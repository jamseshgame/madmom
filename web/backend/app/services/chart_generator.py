"""
Wraps bin/JamseshChartGenerator and bin/JamseshMenu functions for web use.

Imports the generator functions via importlib so we can call them in-process
instead of shelling out, enabling progress callbacks for SSE.
"""

import importlib.machinery
import importlib.util
import os
import re
import sys
import warnings
from collections import defaultdict
from itertools import groupby
from pathlib import Path

import numpy as np

from ..config import settings

# ---------------------------------------------------------------------------
# Import functions from bin/JamseshChartGenerator
# ---------------------------------------------------------------------------

_generator_mod = None


def _load_generator():
    global _generator_mod
    if _generator_mod is not None:
        return _generator_mod
    gen_path = settings.bin_dir / 'JamseshChartGenerator'
    # File has no .py extension — explicitly use SourceFileLoader
    loader = importlib.machinery.SourceFileLoader('chart_generator_bin', str(gen_path))
    spec = importlib.util.spec_from_loader('chart_generator_bin', loader, origin=str(gen_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    _generator_mod = mod
    return mod


# Per-difficulty config: name, sustain threshold, chord threshold, quantize,
# min onset gap (seconds). Earlier versions fed the full onset stream into
# every difficulty, so Easy ended up just as note-dense as Expert. The
# `min_gap` column drops onsets that fall inside a sliding window per
# difficulty, giving an actual density staircase.
DIFFICULTIES = [
    ('ExpertSingle', 0.3, 0.55, 16, 0.0),
    ('HardSingle', 0.4, 0.75, 8, 0.20),
    ('MediumSingle', 0.5, 1.0, 8, 0.50),
    ('EasySingle', 0.6, 1.0, 4, 0.55),
]


# Stem name → .chart section suffix used by the publish flow when
# merging multiple per-stem beatmaps into one notes_fixed_slides.chart.
# Stems not in this map are skipped from the merged chart.
STEM_TO_SECTION_SUFFIX: dict[str, str] = {
    'guitar': 'Single',
    'drums': 'Drums',
    'bass': 'DoubleBass',
    'rhythm': 'DoubleBass',
    'piano': 'Keyboard',
    # Unsplit single-stem tracks (e.g. the Realnote Test bench) treat the
    # whole mix as the lead instrument and publish into [ExpertSingle].
    'song': 'Single',
}


def _normalise_bpm(bpm: float) -> float:
    """Constrain wildly off tempo estimates back into a typical band.

    Beat trackers often double- or half-track on stems with weak transients
    (sustained guitar chords being the canonical case). Snap obvious octave
    errors back inside [70, 180] BPM so downstream tick math doesn't drift.
    """
    if bpm <= 0:
        return 120.0
    while bpm < 70 and bpm * 2 <= 200:
        bpm *= 2
    while bpm > 200 and bpm / 2 >= 50:
        bpm /= 2
    return bpm


def merge_beatmap_charts(
    chart_paths_with_stems: list[tuple[str, str]],
    output_path: str,
) -> dict:
    """Merge per-stem beatmap charts into a single notes_fixed_slides.chart.

    Each input chart was produced by generate_full_chart and contains
    [ExpertSingle], [HardSingle], [MediumSingle], [EasySingle] sections.
    For each beatmap, those sections get renamed based on the source stem
    (drums → ExpertDrums / HardDrums / …) and concatenated into one chart
    that shares the [Song] / [SyncTrack] / [Events] header from the first
    beatmap with a recognised stem.

    Returns a dict with `included` (list of stems that contributed) and
    `skipped` (list of stems with no section mapping or missing chart).
    """
    song_block: str | None = None
    sync_block: str | None = None
    events_block: str | None = None
    sections_out: list[tuple[str, str]] = []
    included: list[str] = []
    skipped: list[str] = []

    for chart_path, stem in chart_paths_with_stems:
        suffix = STEM_TO_SECTION_SUFFIX.get(stem)
        if suffix is None:
            skipped.append(stem)
            continue
        try:
            with open(chart_path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
        except OSError:
            skipped.append(stem)
            continue

        if song_block is None:
            sm = re.search(r'\[Song\]\s*\{([^}]*)\}', content)
            tk = re.search(r'\[SyncTrack\]\s*\{([^}]*)\}', content)
            ev = re.search(r'\[Events\]\s*\{([^}]*)\}', content)
            if sm:
                song_block = sm.group(1)
            if tk:
                sync_block = tk.group(1)
            if ev:
                events_block = ev.group(1)

        any_section = False
        for difficulty in ('Expert', 'Hard', 'Medium', 'Easy'):
            m = re.search(
                r'\[' + difficulty + r'Single\]\s*\{([^}]*)\}',
                content,
            )
            if m:
                sections_out.append((f'{difficulty}{suffix}', m.group(1)))
                any_section = True
        if any_section:
            included.append(stem)
        else:
            skipped.append(stem)

    if not sections_out or song_block is None or sync_block is None:
        return {'included': [], 'skipped': [s for _, s in chart_paths_with_stems]}

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(f'[Song]\n{{{song_block}}}\n')
        f.write(f'[SyncTrack]\n{{{sync_block}}}\n')
        f.write(f'[Events]\n{{{events_block or ""}}}\n')
        for name, content in sections_out:
            f.write(f'[{name}]\n{{{content}}}\n')
    return {'included': included, 'skipped': skipped}


def merge_charts(chart_paths: list[str], section_names: list[str], output_path: str):
    """Merge multiple single-difficulty .chart files into one."""
    sections = {}
    for path, section_name in zip(chart_paths, section_names):
        with open(path, 'r') as f:
            content = f.read()
        match = re.search(r'\[' + section_name + r'\]\n\{([^}]*)\}', content)
        if match:
            sections[section_name] = match.group(1)

    with open(chart_paths[0], 'r') as f:
        content = f.read()
    song_match = re.search(r'\[Song\]\n\{([^}]*)\}', content)
    sync_match = re.search(r'\[SyncTrack\]\n\{([^}]*)\}', content)

    with open(output_path, 'w') as f:
        f.write('[Song]\n{' + song_match.group(1) + '}\n')
        f.write('[SyncTrack]\n{' + sync_match.group(1) + '}\n')
        f.write('[Events]\n{\n}\n')
        for section_name in section_names:
            if section_name in sections:
                f.write(f'[{section_name}]\n{{{sections[section_name]}}}\n')


async def generate_full_chart(
    audio_path: str,
    output_dir: str,
    song_name: str,
    artist: str = 'Unknown',
    album: str = 'Unknown',
    year: str = 'Unknown',
    genre: str = 'Unknown',
    ini_overrides: dict | None = None,
    progress_callback=None,
    grid_path: str | None = None,
):
    """
    Generate a full 4-difficulty chart. Runs CPU-bound work in a thread.

    progress_callback: async callable(step: str, progress: int, message: str)

    Returns dict with chart stats and file paths.
    """
    import asyncio

    gen = _load_generator()

    async def report(step, pct, msg):
        if progress_callback:
            await progress_callback(step, pct, msg)

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Step 1: Audio analysis (full RNN inference) ──
    await report('analyse', 5, 'Running onset detection (RNN)...')

    def _run_analysis():
        from madmom.audio.spectrogram import Spectrogram
        from madmom.features.beats import RNNBeatProcessor
        from madmom.features.onsets import OnsetPeakPickingProcessor, RNNOnsetProcessor
        from madmom.features.tempo import TempoEstimationProcessor

        onset_proc = RNNOnsetProcessor()
        onset_activations = onset_proc(audio_path)

        peak_picker = OnsetPeakPickingProcessor(
            threshold=0.35, fps=100, smooth=0.07, pre_max=0.01, post_max=0.01,
        )
        onsets = peak_picker(onset_activations)

        beat_proc = RNNBeatProcessor()
        beat_activations = beat_proc(audio_path)

        with warnings.catch_warnings():
            warnings.filterwarnings('ignore', message='Usage of `method`')
            tempo_proc = TempoEstimationProcessor(
                method='comb', min_bpm=40.0, max_bpm=250.0,
                act_smooth=0.14, hist_smooth=9, alpha=0.79, fps=100,
            )
        tempi = tempo_proc(beat_activations)
        bpm = float(tempi[0][0])

        spec = Spectrogram(audio_path, frame_size=4096, fps=100, num_channels=1, sample_rate=44100)
        centroids, spreads = gen.compute_spectral_centroids(spec, 100)
        onset_centroids, onset_spreads = gen.compute_onset_centroids(onsets, centroids, spreads, 100)

        return onsets, bpm, onset_centroids, onset_spreads

    onsets, bpm, onset_centroids, onset_spreads = await asyncio.to_thread(_run_analysis)

    raw_bpm = bpm
    bpm = _normalise_bpm(bpm)
    if abs(bpm - raw_bpm) > 0.5:
        await report('analyse', 40, f'Found {len(onsets)} onsets, {bpm:.1f} BPM (snapped from {raw_bpm:.1f})')
    else:
        await report('analyse', 40, f'Found {len(onsets)} onsets, {bpm:.1f} BPM')

    # If a V2 pipeline grid.json exists for this track, override the detected
    # BPM with the grid's primary tempo so all stems in the song share the
    # same SyncTrack. This is the minimal Phase-2 integration; multi-segment
    # tempo maps will require further work in the legacy write_chart.
    if grid_path:
        import json as _json
        try:
            with open(grid_path, 'r') as gf:
                grid = _json.load(gf)
            tempo_segs = grid.get('tempo_segments') or []
            if tempo_segs:
                grid_bpm = float(tempo_segs[0]['micro_bpm']) / 1000.0
                if abs(grid_bpm - bpm) > 0.5:
                    await report('analyse', 42, f'Overriding stem-detected BPM {bpm:.1f} → grid BPM {grid_bpm:.1f}')
                bpm = grid_bpm
        except Exception as e:
            await report('analyse', 42, f'grid.json unusable ({e}); keeping detected BPM')

    if len(onsets) == 0:
        await report('error', -1, 'No onsets detected in audio')
        return None

    def _filter_by_min_gap(onsets_arr, centroids_arr, spreads_arr, min_gap):
        """Keep onsets that are at least `min_gap` seconds apart. Returns
        same shape arrays/lists, indexed in lockstep so centroids/spreads
        stay aligned with their onsets."""
        if min_gap <= 0:
            return onsets_arr, centroids_arr, spreads_arr
        keep_idx = []
        last_t = -1e9
        for i, t in enumerate(onsets_arr):
            if t - last_t >= min_gap:
                keep_idx.append(i)
                last_t = t
        if hasattr(onsets_arr, '__getitem__') and hasattr(onsets_arr, 'shape'):
            return (
                onsets_arr[keep_idx],
                centroids_arr[keep_idx],
                spreads_arr[keep_idx],
            )
        # numpy fallback / list
        return (
            [onsets_arr[i] for i in keep_idx],
            [centroids_arr[i] for i in keep_idx],
            [spreads_arr[i] for i in keep_idx],
        )

    # ── Step 2: Generate each difficulty ──
    resolution = 192
    temp_charts = []
    section_names = []

    for idx, (difficulty, threshold, chord_thresh, quantize, min_gap) in enumerate(DIFFICULTIES):
        label = difficulty.replace('Single', '')
        pct = 45 + idx * 12
        diff_onsets, diff_centroids, diff_spreads = _filter_by_min_gap(
            onsets, onset_centroids, onset_spreads, min_gap,
        )
        await report('generate', pct, f'Generating {label} — {len(diff_onsets)} onsets (min gap {min_gap:.2f}s)')

        def _gen_difficulty(
            difficulty=difficulty, threshold=threshold, chord_thresh=chord_thresh,
            quantize=quantize,
            diff_onsets=diff_onsets, diff_centroids=diff_centroids, diff_spreads=diff_spreads,
        ):
            frets_per_onset = gen.centroid_to_frets(diff_centroids, diff_spreads, chord_thresh)
            notes = []
            for i, onset_time in enumerate(diff_onsets):
                frets = gen.validate_frets(frets_per_onset[i])
                tick = gen.seconds_to_ticks(onset_time, bpm, resolution)
                tick = gen.quantize_tick(tick, resolution, quantize)
                sustain = gen.compute_sustain_ticks(i, diff_onsets, bpm, resolution, threshold)
                for fret in frets:
                    notes.append((tick, fret, 0 if fret == 7 else sustain))

            # Deduplicate
            seen = set()
            deduped = []
            for tick, fret, sustain in notes:
                key = (tick, fret)
                if key not in seen:
                    seen.add(key)
                    deduped.append((tick, fret, sustain))

            deduped = gen.unify_chord_sustains(deduped)
            deduped.sort(key=lambda n: (n[0], n[1]))

            # Final validation
            validated = []
            for tick, group in groupby(deduped, key=lambda n: n[0]):
                tick_notes = list(group)
                frets_at_tick = [f for _, f, _ in tick_notes]
                valid = gen.validate_frets(frets_at_tick)
                sustain = max(s for _, _, s in tick_notes)
                for fret in valid:
                    validated.append((tick, fret, sustain))
            deduped = validated

            # Slides (chord slides use fixed parallel pairs)
            sequences = gen.detect_slide_sequences(deduped, bpm, resolution)
            slide_events = []
            if sequences:
                sequences, deduped = gen.promote_chord_slides(sequences, deduped, ratio=0.3)
                deduped, slide_events = gen.apply_slide_conversion(deduped, sequences)

            deduped = gen.unify_chord_sustains(deduped)
            return deduped, slide_events

        notes, slide_events = await asyncio.to_thread(_gen_difficulty)

        temp_path = str(out_dir / f'_temp_{difficulty}.chart')
        gen.write_chart(temp_path, song_name, bpm, resolution, difficulty, notes, slide_events)
        temp_charts.append(temp_path)
        section_names.append(difficulty)

    # ── Step 3: Merge ──
    await report('merge', 90, 'Merging difficulties...')
    chart_output = str(out_dir / 'notes.chart')
    merge_charts(temp_charts, section_names, chart_output)

    # Clean up temp charts
    for p in temp_charts:
        if os.path.exists(p):
            os.remove(p)

    # ── Step 4: Convert audio ──
    await report('convert', 93, 'Converting audio to song.ogg...')
    from .audio import convert_to_ogg

    ogg_path = str(out_dir / 'song.ogg')
    convert_to_ogg(audio_path, ogg_path)

    # ── Step 5: Write song.ini with note type summaries ──
    await report('finalize', 97, 'Writing song.ini...')
    from .chart_analyser import analyse_chart_file

    with open(chart_output, 'r') as f:
        chart_content = f.read()
    analysis = analyse_chart_file(chart_content)

    pair_names = ['0+1', '1+2', '2+3', '3+4']
    ini_path = str(out_dir / 'song.ini')
    ov = ini_overrides or {}
    with open(ini_path, 'w') as f:
        f.write('[song]\n')
        f.write(f'name = {song_name}\n')
        f.write(f'artist = {artist}\n')
        f.write(f'album = {album}\n')
        f.write(f'genre = {genre}\n')
        f.write(f'year = {year}\n')
        f.write(f'charter = {ov.get("charter", "Jamsesh")}\n')
        f.write(f'loading_phrase = {ov.get("loading_phrase", "")}\n')
        if ov.get('icon'):
            f.write(f'icon = {ov["icon"]}\n')
        f.write(f'album_track = {ov.get("album_track", 0)}\n')
        f.write(f'playlist_track = {ov.get("playlist_track", 0)}\n')
        f.write(f'delay = {ov.get("delay", 0)}\n')
        f.write(f'preview_start_time = {ov.get("preview_start_time", 0)}\n')
        if ov.get('video_start_time'):
            f.write(f'video_start_time = {ov["video_start_time"]}\n')
        if ov.get('song_length'):
            f.write(f'song_length = {ov["song_length"]}\n')
        # Difficulty ratings
        for diff_key in [
            'diff_guitar', 'diff_rhythm', 'diff_bass', 'diff_guitar_coop',
            'diff_drums', 'diff_drums_real', 'diff_keys',
            'diff_guitarghl', 'diff_bassghl',
        ]:
            val = ov.get(diff_key, -1)
            f.write(f'{diff_key} = {val}\n')
        # Gameplay
        if ov.get('hopo_frequency'):
            f.write(f'hopo_frequency = {ov["hopo_frequency"]}\n')
        if ov.get('sustain_cutoff_threshold'):
            f.write(f'sustain_cutoff_threshold = {ov["sustain_cutoff_threshold"]}\n')
        if ov.get('five_lane_drums'):
            f.write('five_lane_drums = True\n')
        if ov.get('modchart'):
            f.write('modchart = True\n')

        for section_name, stats in analysis.get('difficulties', {}).items():
            prefix = section_name.replace('Single', '').lower()
            f.write(f'\n[{prefix}_stats]\n')
            f.write(f'total_events = {stats["total_events"]}\n')
            for fret in range(5):
                f.write(f'single_{fret} = {stats["singles"].get(str(fret), 0)}\n')
            for fret in range(5):
                f.write(f'hold_{fret} = {stats["holds"].get(str(fret), 0)}\n')
            for fret in range(5):
                f.write(f'slide_{fret} = {stats["slides"].get(str(fret), 0)}\n')
            for pname in pair_names:
                f.write(f'chord_{pname} = {stats["chords"].get(pname, 0)}\n')
            for pname in pair_names:
                f.write(f'chord_hold_{pname} = {stats["chord_holds"].get(pname, 0)}\n')
            for pname in pair_names:
                f.write(f'chord_slide_{pname} = {stats["chord_slides"].get(pname, 0)}\n')
            f.write(f'open_normal = {stats["open_normal"]}\n')
            f.write(f'open_hold = {stats["open_hold"]}\n')
            f.write(f'open_slide = {stats["open_slide"]}\n')

    return {
        'chart_path': chart_output,
        'ogg_path': ogg_path,
        'ini_path': ini_path,
        'bpm': bpm,
        'num_onsets': len(onsets),
        'song_name': song_name,
        'artist': artist,
        'folder_name': f'{artist} - {song_name}',
    }
