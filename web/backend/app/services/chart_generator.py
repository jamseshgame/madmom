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


def _esc(s: str) -> str:
    """Escape a string for use inside a [Beatmaps] row's double-quoted value.

    Strips newlines (which would corrupt the line-oriented row format) and
    escapes embedded double quotes."""
    return s.replace('\r', '').replace('\n', ' ').replace('"', '\\"')


def merge_beatmap_charts(
    chart_paths_with_meta: list[tuple[str, str, dict]],
    output_path: str,
) -> dict:
    """Merge per-stem beatmap charts into a single notes_fixed_slides.chart.

    Each input tuple is (chart_path, stem, meta) where meta is
    {'preset': str, 'beatmap_id': str, 'is_active': bool}. The caller is
    responsible for ordering — primary-first per stem, then alternates in
    whatever order they want exposed in the chart (the merger emits in
    input order within each stem).

    Sections from each beatmap are renamed by stem-suffix
    (drums → ExpertDrums/HardDrums/..., guitar → ExpertSingle/HardSingle/...).
    The first beatmap per stem gets unnumbered names; subsequent beatmaps
    for the same stem get numeric suffixes ([ExpertDrums2], [ExpertDrums3]).
    All four difficulties for a single beatmap share the same N — if a
    beatmap is missing one difficulty, that specific section is simply
    absent (other difficulties for the same beatmap still align at the
    beatmap's N).

    A [Beatmaps] metadata block lists every emitted section with its source
    preset, active/alt tag, and beatmap_id. Clone Hero ignores unknown
    sections; the published chart is still CH-playable using the unnumbered
    (active) sections.

    Returns {'included': [stems...], 'skipped': [stems...]}. A stem may
    appear in 'included' multiple times if multiple beatmaps for it
    contributed sections; 'skipped' contains stems whose chart had no
    sections OR whose stem name has no STEM_TO_SECTION_SUFFIX entry.
    """
    song_block: str | None = None
    sync_block: str | None = None
    events_block: str | None = None
    # Each entry: (section_name, content, suffix, n, beatmaps_row_text).
    # Storing the [Beatmaps] row text alongside the section info lets a single
    # sort below order both lists consistently.
    sections_out: list[tuple[str, str, str, int, str]] = []
    included: list[str] = []
    skipped: list[str] = []

    # Per-stem counter — advances only when the beatmap actually contributed
    # one or more sections (so a beatmap with zero usable difficulties
    # doesn't burn the next N slot).
    beatmap_index_per_stem: dict[str, int] = {}

    for chart_path, stem, meta in chart_paths_with_meta:
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

        # Capture the first chart's header blocks — those become the merged
        # chart's [Song]/[SyncTrack]/[Events] (all beatmaps for a track
        # share the same tempo grid via the V2 pipeline).
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

        candidate_n = beatmap_index_per_stem.get(stem, 0) + 1
        any_section = False
        preset = _esc(meta.get('preset', '') or '')
        bid = _esc(meta.get('beatmap_id', '') or '')
        name_tag = 'active' if meta.get('is_active') else 'alt'

        for difficulty in ('Expert', 'Hard', 'Medium', 'Easy'):
            m = re.search(
                r'\[' + difficulty + r'Single\]\s*\{([^}]*)\}',
                content,
            )
            if not m:
                continue
            section_name = (
                f'{difficulty}{suffix}' if candidate_n == 1
                else f'{difficulty}{suffix}{candidate_n}'
            )
            row_text = (
                f'  {section_name} = preset="{preset}" name="{name_tag}" beatmap_id="{bid}"'
            )
            sections_out.append((section_name, m.group(1), suffix, candidate_n, row_text))
            any_section = True

        if any_section:
            beatmap_index_per_stem[stem] = candidate_n
            included.append(stem)
        else:
            skipped.append(stem)

    if not sections_out or song_block is None or sync_block is None:
        # Empty input or no usable sections — return without writing.
        # Preserves the test expectation that no file is written for empty
        # input or all-unknown-stems input.
        return {'included': included, 'skipped': skipped}

    # Difficulty order inside one beatmap: Expert → Hard → Medium → Easy.
    diff_order = {'Expert': 0, 'Hard': 1, 'Medium': 2, 'Easy': 3}
    # Stem-suffix order: emit in the order suffixes first appeared (stable).
    suffix_first_seen: dict[str, int] = {}
    for _, _, suf, _, _ in sections_out:
        suffix_first_seen.setdefault(suf, len(suffix_first_seen))

    def _section_sort_key(item):
        section_name, _content, suffix, n, _row = item
        # Difficulty prefix sits before the suffix; pull it back out.
        diff = section_name[: section_name.index(suffix)]
        return (suffix_first_seen[suffix], n, diff_order.get(diff, 99))

    # Sort by (stem-suffix-first-seen, n, difficulty) so all four difficulties
    # of the same beatmap stay adjacent in the file and stems are grouped.
    sections_sorted = sorted(sections_out, key=_section_sort_key)

    # Derive [Beatmaps] rows from the SORTED sections so they describe the
    # sections in the same order they appear in the file.
    beatmaps_rows = [row for _, _, _, _, row in sections_sorted]

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(f'[Song]\n{{{song_block}}}\n')
        f.write(f'[SyncTrack]\n{{{sync_block}}}\n')
        f.write(f'[Events]\n{{{events_block or ""}}}\n')
        if beatmaps_rows:
            body = '\n'.join(beatmaps_rows)
            f.write(f'[Beatmaps]\n{{\n{body}\n}}\n')
        for section_name, content, _suffix, _n, _row in sections_sorted:
            f.write(f'[{section_name}]\n{{{content}}}\n')
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


def write_chart_song_ini(
    out_dir: Path | str,
    *,
    chart_path: str,
    song_name: str,
    artist: str,
    album: str,
    genre: str,
    year: str,
    ini_overrides: dict | None = None,
) -> str:
    """Write song.ini next to a notes.chart, including [<diff>_stats]
    sections derived from the chart.

    Returns the path to the written ini.
    """
    from .chart_analyser import analyse_chart_file

    out_dir = Path(out_dir)
    with open(chart_path, 'r') as f:
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
        for diff_key in (
            'diff_guitar', 'diff_rhythm', 'diff_bass', 'diff_guitar_coop',
            'diff_drums', 'diff_drums_real', 'diff_keys',
            'diff_guitarghl', 'diff_bassghl',
        ):
            val = ov.get(diff_key, -1)
            f.write(f'{diff_key} = {val}\n')
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

    return ini_path


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
    stem: str | None = None,
):
    """
    Generate a full 4-difficulty chart. Runs CPU-bound work in a thread.

    progress_callback: async callable(step: str, progress: int, message: str)
    stem: source stem name. 'drums' forces single-hit output — no sustains
        and no slides, since percussion notes are always plain hits.

    Returns dict with chart stats and file paths.
    """
    import asyncio

    gen = _load_generator()

    # Drum charts are single-hit only: percussion has no sustains or slides.
    # When generating from the drums stem, force every note to zero sustain
    # and skip slide promotion so the chart is pure hits.
    single_hits_only = stem == 'drums'

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
                sustain = (
                    0 if single_hits_only
                    else gen.compute_sustain_ticks(i, diff_onsets, bpm, resolution, threshold)
                )
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

            # Slides (chord slides use fixed parallel pairs). Drums get
            # none — single hits only.
            slide_events = []
            if not single_hits_only:
                sequences = gen.detect_slide_sequences(deduped, bpm, resolution)
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
    ini_path = write_chart_song_ini(
        out_dir=out_dir,
        chart_path=chart_output,
        song_name=song_name,
        artist=artist,
        album=album,
        genre=genre,
        year=year,
        ini_overrides=ini_overrides,
    )

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
