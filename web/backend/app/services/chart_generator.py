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


_DIFFICULTY_PREFIXES = ('Expert', 'Hard', 'Medium', 'Easy')


def _read_resolution(chart_text: str) -> int | None:
    """Parse `[Song] Resolution = N`. Returns None if not found."""
    m = re.search(r'\[Song\]\s*\{([^}]*)\}', chart_text)
    if not m:
        return None
    rm = re.search(r'(?im)^\s*Resolution\s*=\s*(\d+)', m.group(1))
    return int(rm.group(1)) if rm else None


def _extract_section_body(chart_text: str, section: str) -> str | None:
    """Return the brace body of [section], or None if the section is absent."""
    m = re.search(r'\[' + re.escape(section) + r'\]\s*\{([^}]*)\}', chart_text)
    return m.group(1) if m else None


def _rescale_block(body: str, ratio: float) -> str:
    """Scale the leading tick of each `  <tick> = <event>` line by `ratio`.
    Non-event lines (blank, braces already stripped) pass through unchanged."""
    body = body.replace('\r\n', '\n')
    if ratio == 1.0:
        return body
    out = []
    for line in body.split('\n'):
        m = re.match(r'^(\s*)(\d+)(\s*=.*)$', line)
        if m:
            out.append(f'{m.group(1)}{round(int(m.group(2)) * ratio)}{m.group(3)}')
        else:
            out.append(line)
    return '\n'.join(out)


def splice_difficulty(
    source_chart_text: str,
    source_difficulty: str,
    target_chart_text: str,
    target_difficulty: str,
) -> tuple[str, bool]:
    """Lift `[source_difficulty]` out of the source chart and write it into the
    target chart as `[target_difficulty]`, rescaling note ticks when the two
    charts have different `[Song] Resolution`. Replaces an existing target block
    in place (preserving every other section) or appends if the slot is empty.

    Returns `(new_target_chart_text, overwrote)` where `overwrote` is True when
    the target slot already held a block. Raises ValueError if the source chart
    has no `[source_difficulty]` section.
    """
    src_body = _extract_section_body(source_chart_text, source_difficulty)
    if src_body is None:
        raise ValueError(f'source chart has no [{source_difficulty}] section')

    src_res = _read_resolution(source_chart_text)
    tgt_res = _read_resolution(target_chart_text)
    ratio = (tgt_res / src_res) if (src_res and tgt_res and src_res != tgt_res) else 1.0
    new_body = _rescale_block(src_body, ratio)
    new_block = f'[{target_difficulty}]\n{{{new_body}}}\n'

    pattern = re.compile(r'\[' + re.escape(target_difficulty) + r'\]\s*\{[^}]*\}\n?')
    if pattern.search(target_chart_text):
        # Use a function replacement so backslashes/braces in new_block are literal.
        return pattern.sub(lambda _m: new_block, target_chart_text, count=1), True

    sep = '' if (not target_chart_text or target_chart_text.endswith('\n')) else '\n'
    return target_chart_text + sep + new_block, False


def chart_difficulties(chart_text: str) -> list[dict]:
    """List the difficulty sections present in a chart as
    `[{'name': 'ExpertSingle', 'note_count': 12}, ...]`. Only sections whose
    name is `<prefix><suffix>` (e.g. ExpertSingle, HardDrums) are reported;
    `[Song]`/`[SyncTrack]`/`[Events]`/`[Beatmaps]` are skipped."""
    suffixes = set(STEM_TO_SECTION_SUFFIX.values())
    out: list[dict] = []
    for m in re.finditer(r'\[([A-Za-z]+)\]\s*\{([^}]*)\}', chart_text):
        name = m.group(1)
        if not any(name.startswith(p) for p in _DIFFICULTY_PREFIXES):
            continue
        if not any(name.endswith(s) for s in suffixes):
            continue
        note_count = sum(1 for ln in m.group(2).split('\n') if re.search(r'=\s*N\s', ln))
        out.append({'name': name, 'note_count': note_count})
    return out


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

    # Parallel to sections_out — one record per beatmap that contributed
    # sections. Carries the same identifiers as the [Beatmaps] rows in the
    # chart so the caller (publish_track_to_game → write_song_ini) can mirror
    # them into song.ini's [beatmap_N] blocks for Unity's variant picker.
    beatmap_records: list[dict] = []

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
        contributed_sections: list[str] = []

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
            contributed_sections.append(section_name)
            any_section = True

        if any_section:
            beatmap_index_per_stem[stem] = candidate_n
            included.append(stem)
            beatmap_records.append({
                'id': meta.get('beatmap_id', '') or '',
                'name': meta.get('preset', '') or '',  # display name = preset for v1
                'preset': meta.get('preset', '') or '',
                'stem': stem,
                'is_active': bool(meta.get('is_active')),
                '_n': candidate_n,  # internal — stripped before return
                'sections': contributed_sections,
            })
        else:
            skipped.append(stem)

    if not sections_out or song_block is None or sync_block is None:
        # Empty input or no usable sections — return without writing.
        # Preserves the test expectation that no file is written for empty
        # input or all-unknown-stems input.
        return {'included': included, 'skipped': skipped, 'sections_by_beatmap': []}

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

    # Order beatmap_records to mirror the chart's stem/n ordering, then sort
    # each record's own `sections` list by difficulty and strip the internal
    # `_n` field so callers (write_song_ini) see a clean public schema.
    beatmap_records.sort(
        key=lambda r: (
            suffix_first_seen.get(STEM_TO_SECTION_SUFFIX.get(r['stem'], ''), 0),
            r['_n'],
        ),
    )
    for r in beatmap_records:
        suf = STEM_TO_SECTION_SUFFIX.get(r['stem'], '')
        if suf:
            r['sections'].sort(
                key=lambda sn: diff_order.get(
                    sn[: sn.index(suf)] if suf in sn else '', 99
                )
            )
        r.pop('_n', None)

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(f'[Song]\n{{{song_block}}}\n')
        f.write(f'[SyncTrack]\n{{{sync_block}}}\n')
        f.write(f'[Events]\n{{{events_block or ""}}}\n')
        if beatmaps_rows:
            body = '\n'.join(beatmaps_rows)
            f.write(f'[Beatmaps]\n{{\n{body}\n}}\n')
        for section_name, content, _suffix, _n, _row in sections_sorted:
            f.write(f'[{section_name}]\n{{{content}}}\n')
    return {
        'included': included,
        'skipped': skipped,
        'sections_by_beatmap': beatmap_records,
    }


# ---------------------------------------------------------------------------
# Pull-side inverses of merge_beatmap_charts — used by the Game Library pull
# shim (split a published chart into per-stem editor charts) and push flow
# (splice edited per-stem charts back into the published chart).
# ---------------------------------------------------------------------------

# Longest-first so e.g. a future suffix that prefixes another can't shadow it.
_SUFFIX_ALTERNATION = '|'.join(sorted(set(STEM_TO_SECTION_SUFFIX.values()), key=len, reverse=True))
_DIFF_SECTION_RE = re.compile(
    r'\[(Expert|Hard|Medium|Easy)(' + _SUFFIX_ALTERNATION + r')(\d*)\]\s*\{([^}]*)\}'
)
_DIFF_NAME_RE = re.compile(r'(Expert|Hard|Medium|Easy)(' + _SUFFIX_ALTERNATION + r')(\d*)')
_GENERIC_SECTION_RE = re.compile(r'\[([^\]\n]+)\]\s*\{([^}]*)\}')
_BEATMAPS_KV_RE = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')

_DIFF_ORDER = {'Expert': 0, 'Hard': 1, 'Medium': 2, 'Easy': 3}


def parse_beatmaps_block(chart_text: str) -> dict[str, dict]:
    """Parse the [Beatmaps] metadata block written by merge_beatmap_charts.

    Returns {section_name: {'preset', 'tag', 'beatmap_id'}} — one entry per
    row. Charts without a [Beatmaps] block return {}.
    """
    body = _extract_section_body(chart_text, 'Beatmaps')
    if body is None:
        return {}
    out: dict[str, dict] = {}
    for line in body.splitlines():
        m = re.match(r'^\s*([A-Za-z0-9]+)\s*=\s*(.+)$', line)
        if not m:
            continue
        fields = {k: v.replace('\\"', '"') for k, v in _BEATMAPS_KV_RE.findall(m.group(2))}
        out[m.group(1)] = {
            'preset': fields.get('preset', ''),
            'tag': fields.get('name', ''),
            'beatmap_id': fields.get('beatmap_id', ''),
        }
    return out


def _suffix_to_stem(suffix: str, available_stems: set[str]) -> str:
    """Pick the stem a merged-chart section suffix most plausibly came from,
    preferring stems whose audio actually exists in the pulled folder
    (e.g. DoubleBass → 'rhythm' when rhythm.ogg is present, else 'bass')."""
    candidates = [s for s, suf in STEM_TO_SECTION_SUFFIX.items() if suf == suffix]
    for stem in candidates:
        if stem in available_stems:
            return stem
    defaults = {'Single': 'song', 'Drums': 'drums', 'DoubleBass': 'rhythm', 'Keyboard': 'piano'}
    return defaults.get(suffix) or (candidates[0] if candidates else 'song')


def _is_merge_managed_section(name: str) -> bool:
    """True for sections that splice_stem_charts_into_merged rebuilds from
    scratch: difficulty sections, their SlideMeta companions, and [Beatmaps]."""
    if name == 'Beatmaps':
        return True
    base = name[len('SlideMeta_'):] if name.startswith('SlideMeta_') else name
    return _DIFF_NAME_RE.fullmatch(base) is not None


def split_merged_chart(chart_text: str, available_stems: set[str] | None = None) -> list[dict]:
    """Inverse of merge_beatmap_charts: explode a published multi-stem chart
    into one editor-convention chart per (stem, alternate) group.

    Difficulty sections are grouped by (suffix, alternate number) — all four
    difficulties of [.*Drums2] form one group — and renamed back to the
    [*Single] family that per-stem beatmap charts use. [SlideMeta_<merged
    section>] blocks are renamed to [SlideMeta_<DifficultySingle>] so slide
    grouping survives the round trip. Header blocks ([Song]/[SyncTrack]/
    [Events]) are copied into every split chart. Per-group metadata comes
    from the [Beatmaps] block when present.

    Returns [{'stem', 'suffix', 'n', 'sections', 'preset', 'beatmap_id',
    'is_active', 'chart_text'}] ordered as the sections appear in the file.
    """
    available = available_stems or set()
    song = _extract_section_body(chart_text, 'Song') or ''
    sync = _extract_section_body(chart_text, 'SyncTrack') or ''
    events = _extract_section_body(chart_text, 'Events') or ''
    meta_rows = parse_beatmaps_block(chart_text)

    groups: dict[tuple[str, int], list[tuple[str, str]]] = {}
    for m in _DIFF_SECTION_RE.finditer(chart_text):
        diff, suffix, num, body = m.groups()
        groups.setdefault((suffix, int(num) if num else 1), []).append((diff, body))

    out: list[dict] = []
    for (suffix, n), diffs in groups.items():
        diffs.sort(key=lambda d: _DIFF_ORDER.get(d[0], 99))
        merged_names = [f'{diff}{suffix}{n if n > 1 else ""}' for diff, _ in diffs]
        parts = [f'[Song]\n{{{song}}}\n', f'[SyncTrack]\n{{{sync}}}\n', f'[Events]\n{{{events}}}\n']
        for (diff, body), merged_name in zip(diffs, merged_names):
            parts.append(f'[{diff}Single]\n{{{body}}}\n')
            slide = _extract_section_body(chart_text, f'SlideMeta_{merged_name}')
            if slide is not None:
                parts.append(f'[SlideMeta_{diff}Single]\n{{{slide}}}\n')
        row = next((meta_rows[name] for name in merged_names if name in meta_rows), None)
        out.append({
            'stem': _suffix_to_stem(suffix, available),
            'suffix': suffix,
            'n': n,
            'sections': merged_names,
            'preset': (row or {}).get('preset', ''),
            'beatmap_id': (row or {}).get('beatmap_id', ''),
            'is_active': (row['tag'] == 'active') if row else (n == 1),
            'chart_text': ''.join(parts),
        })
    return out


def splice_stem_charts_into_merged(
    merged_text: str,
    contributions: list[tuple[str, str, dict]],
) -> str:
    """Push-side counterpart of split_merged_chart: rebuild a published chart
    from edited per-stem charts while preserving everything the editor
    doesn't manage.

    Each contribution is (chart_text, stem, meta) with meta
    {'preset', 'beatmap_id', 'is_active'}, in publish order (primary first
    per stem — same contract as merge_beatmap_charts). Difficulty sections,
    their SlideMeta companions, and the [Beatmaps] index are regenerated
    from the contributions; [Song]/[SyncTrack]/[Events] come from the first
    contribution (falling back to the old merged chart); every other block
    in merged_text ([JamseshVocals], [TutorialScript], lyric phrases, …) is
    carried over verbatim.
    """
    old: dict[str, str] = {}
    preserved: list[tuple[str, str]] = []
    for m in _GENERIC_SECTION_RE.finditer(merged_text or ''):
        name, body = m.group(1), m.group(2)
        old.setdefault(name, body)
        if name in ('Song', 'SyncTrack', 'Events') or _is_merge_managed_section(name):
            continue
        preserved.append((name, body))

    primary_text = contributions[0][0] if contributions else ''
    song = _extract_section_body(primary_text, 'Song') or old.get('Song', '')
    sync = _extract_section_body(primary_text, 'SyncTrack') or old.get('SyncTrack', '')
    events = _extract_section_body(primary_text, 'Events')
    if events is None:
        events = old.get('Events', '')

    # Rebuild difficulty sections with merge_beatmap_charts' numbering rules.
    # Counter keyed by suffix (not stem) so the two stems sharing a suffix
    # (bass/rhythm, guitar/song) can't emit colliding unnumbered sections.
    sections_out: list[tuple[str, str, str, int, str]] = []
    slide_out: dict[str, str] = {}
    counter: dict[str, int] = {}
    for chart_text, stem, meta in contributions:
        suffix = STEM_TO_SECTION_SUFFIX.get(stem)
        if suffix is None:
            continue
        candidate_n = counter.get(suffix, 0) + 1
        preset = _esc(meta.get('preset', '') or '')
        bid = _esc(meta.get('beatmap_id', '') or '')
        tag = 'active' if meta.get('is_active') else 'alt'
        any_section = False
        for diff in ('Expert', 'Hard', 'Medium', 'Easy'):
            body = _extract_section_body(chart_text, f'{diff}Single')
            if body is None:
                continue
            name = f'{diff}{suffix}' if candidate_n == 1 else f'{diff}{suffix}{candidate_n}'
            row = f'  {name} = preset="{preset}" name="{tag}" beatmap_id="{bid}"'
            sections_out.append((name, body, suffix, candidate_n, row))
            slide = _extract_section_body(chart_text, f'SlideMeta_{diff}Single')
            if slide is not None:
                slide_out[name] = slide
            any_section = True
        if any_section:
            counter[suffix] = candidate_n

    suffix_first_seen: dict[str, int] = {}
    for _, _, suf, _, _ in sections_out:
        suffix_first_seen.setdefault(suf, len(suffix_first_seen))

    def _sort_key(item):
        name, _body, suffix, n, _row = item
        diff = name[: name.index(suffix)]
        return (suffix_first_seen[suffix], n, _DIFF_ORDER.get(diff, 99))

    sections_sorted = sorted(sections_out, key=_sort_key)

    parts = [f'[Song]\n{{{song}}}\n', f'[SyncTrack]\n{{{sync}}}\n', f'[Events]\n{{{events}}}\n']
    if sections_sorted:
        rows = '\n'.join(row for _, _, _, _, row in sections_sorted)
        parts.append(f'[Beatmaps]\n{{\n{rows}\n}}\n')
    for name, body, _suffix, _n, _row in sections_sorted:
        parts.append(f'[{name}]\n{{{body}}}\n')
        if name in slide_out:
            parts.append(f'[SlideMeta_{name}]\n{{{slide_out[name]}}}\n')
    for name, body in preserved:
        parts.append(f'[{name}]\n{{{body}}}\n')
    return ''.join(parts)


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
