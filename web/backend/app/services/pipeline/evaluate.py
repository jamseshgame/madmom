"""Objective chart evaluation: a generated .chart against a reference chart
for the same audio (a good community Clone Hero chart, or a hand-fixed
version of an earlier generation).

Reviewer tags say *that* something is off; this says *how much*, per
preset, so an engine or parameter change produces a number:

  onset F-measure      notes within ±tolerance of a reference note
                       (per difficulty; the same metric madmom's onset
                       evaluation uses)
  lane accuracy        drums: fraction of matched notes on the right pad
                       (kick/snare/hat/tom/cymbal) — lanes are semantic
  contour agreement    pitched: for consecutive matched notes, does the
                       chart step the same direction as the reference
  self-consistency     fraction of bars whose rhythm pattern repeats an
                       earlier bar *and* whose lanes repeat it too
  density ratio        notes/sec vs the reference, per difficulty
  chord / sustain rate how often the chart uses chords and sustains

`evaluate_charts(ref_text, cand_text)` returns a dict; `scripts/eval_chart.py`
wraps it as a CLI. Pure Python.
"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from .tempo_math import build_tempo_segments, tick_to_seconds

# Difficulty prefixes and the instrument suffixes a chart may use.
DIFFICULTIES = ('Expert', 'Hard', 'Medium', 'Easy')
_INSTRUMENT_SUFFIXES = ('Single', 'Drums', 'DoubleBass', 'DoubleGuitar', 'DoubleRhythm', 'Keyboard')

_SECTION_RE = re.compile(r'^\[(?P<name>[^\]]+)\]\s*$')
_ROW_RE = re.compile(r'^\s*(?P<tick>\d+)\s*=\s*(?P<body>.+?)\s*$')


class Chart:
    def __init__(self) -> None:
        self.resolution = 192
        self.tempo: list[dict[str, int]] = []
        self.sections: dict[str, list[tuple[int, int, int]]] = {}  # name -> [(tick, note, sustain)]
        self.time_sigs: list[tuple[int, int]] = []

    def segments(self):
        markers = [{'tick': t['tick'], 'micro_bpm': t['micro_bpm']} for t in self.tempo] or \
                  [{'tick': 0, 'micro_bpm': 120000}]
        return build_tempo_segments(markers, self.resolution)

    def seconds(self, tick: int) -> float:
        return tick_to_seconds(tick, self.segments(), self.resolution)

    def bar_ticks(self) -> int:
        num = self.time_sigs[0][1] if self.time_sigs else 4
        return num * self.resolution


def parse_chart(text: str) -> Chart:
    chart = Chart()
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        m = _SECTION_RE.match(line)
        if m:
            current = m.group('name')
            chart.sections.setdefault(current, []) if _is_note_section(current) else None
            continue
        if line in ('{', '}') or current is None:
            continue
        row = _ROW_RE.match(line)
        if not row:
            if current == 'Song' and line.lower().startswith('resolution'):
                chart.resolution = int(line.split('=')[1].strip())
            continue
        tick = int(row.group('tick'))
        parts = row.group('body').split()
        if current == 'SyncTrack':
            if parts[0] == 'B':
                chart.tempo.append({'tick': tick, 'micro_bpm': int(parts[1])})
            elif parts[0] == 'TS':
                chart.time_sigs.append((tick, int(parts[1])))
        elif _is_note_section(current) and parts[0] == 'N':
            chart.sections[current].append((tick, int(parts[1]), int(parts[2]) if len(parts) > 2 else 0))
    chart.tempo.sort(key=lambda t: t['tick'])
    chart.time_sigs.sort()
    return chart


def _is_note_section(name: str) -> bool:
    return any(name.startswith(d) for d in DIFFICULTIES) and any(name.endswith(s) or name.rstrip('0123456789').endswith(s) for s in _INSTRUMENT_SUFFIXES)


def is_drum_section(name: str) -> bool:
    return 'drums' in name.lower()


# ── note normalisation ───────────────────────────────────────────────────

def drum_rows_to_lanes(rows: list[tuple[int, int, int]]) -> dict[int, set[int]]:
    """Pro Drums rows → {tick: lanes} with 0 kick, 1 snare, 2 hat, 3 tom, 4 cymbal.
    Mirrors drumNoteToLane in the editor (chartio.ts)."""
    by_tick: dict[int, list[int]] = defaultdict(list)
    for tick, note, _s in rows:
        by_tick[tick].append(note)
    out: dict[int, set[int]] = {}
    for tick, notes in by_tick.items():
        mods = {n for n in notes if n in (66, 67, 68)}
        lanes: set[int] = set()
        for n in notes:
            if n == 0:
                lanes.add(0)
            elif n == 1:
                lanes.add(1)
            elif n == 2:
                lanes.add(2 if 66 in mods else 3)
            elif n == 3:
                lanes.add(4 if 67 in mods else 3)
            elif n == 4:
                lanes.add(4 if 68 in mods else 3)  # floor tom scored as tom
            elif n == 32:
                lanes.add(4)
        if lanes:
            out[tick] = lanes
    return out


def guitar_rows_to_lanes(rows: list[tuple[int, int, int]]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for tick, note, sustain in rows:
        if note in (0, 1, 2, 3, 4, 7):
            e = out.setdefault(tick, {'frets': set(), 'sustain': 0})
            e['frets'].add(note)
            e['sustain'] = max(e['sustain'], sustain)
    return out


# ── matching ─────────────────────────────────────────────────────────────

def match_times(ref: list[float], cand: list[float], tol: float) -> list[tuple[int, int]]:
    """Greedy nearest-first one-to-one matching within tolerance."""
    pairs = sorted(
        ((abs(r - c), i, j) for i, r in enumerate(ref) for j, c in enumerate(cand) if abs(r - c) <= tol),
    )
    used_r: set[int] = set()
    used_c: set[int] = set()
    out = []
    for _d, i, j in pairs:
        if i in used_r or j in used_c:
            continue
        used_r.add(i)
        used_c.add(j)
        out.append((i, j))
    return sorted(out)


def _prf(tp: int, n_ref: int, n_cand: int) -> dict[str, float]:
    p = tp / n_cand if n_cand else 0.0
    r = tp / n_ref if n_ref else 0.0
    f = 2 * p * r / (p + r) if (p + r) else 0.0
    return {'precision': round(p, 4), 'recall': round(r, 4), 'f1': round(f, 4)}


def self_consistency(ticks_lanes: list[tuple[int, tuple[int, ...]]], bar_ticks: int) -> float | None:
    """Among bars whose rhythm (ticks mod bar) repeats an earlier bar, the
    fraction whose lane pattern repeats it too."""
    bars: dict[int, list[tuple[int, tuple[int, ...]]]] = defaultdict(list)
    for tick, lanes in ticks_lanes:
        bars[tick // bar_ticks].append((tick % bar_ticks, lanes))
    seen_rhythm: dict[tuple[int, ...], tuple] = {}
    repeats = consistent = 0
    for b in sorted(bars):
        notes = sorted(bars[b])
        rhythm = tuple(t for t, _ in notes)
        pattern = tuple(l for _, l in notes)
        if len(rhythm) < 2:
            continue
        if rhythm in seen_rhythm:
            repeats += 1
            if seen_rhythm[rhythm] == pattern:
                consistent += 1
        else:
            seen_rhythm[rhythm] = pattern
    return round(consistent / repeats, 4) if repeats else None


def evaluate_section(ref: Chart, cand: Chart, ref_name: str, cand_name: str, tol_s: float = 0.05) -> dict[str, Any]:
    drums = is_drum_section(ref_name)
    ref_rows, cand_rows = ref.sections.get(ref_name, []), cand.sections.get(cand_name, [])
    out: dict[str, Any] = {'reference_section': ref_name, 'candidate_section': cand_name, 'drums': drums}
    if drums:
        r_lanes = drum_rows_to_lanes(ref_rows)
        c_lanes = drum_rows_to_lanes(cand_rows)
        r_ticks, c_ticks = sorted(r_lanes), sorted(c_lanes)
        r_t = [ref.seconds(t) for t in r_ticks]
        c_t = [cand.seconds(t) for t in c_ticks]
        pairs = match_times(r_t, c_t, tol_s)
        out['onsets'] = _prf(len(pairs), len(r_t), len(c_t))
        per_lane: dict[str, dict[str, int]] = {}
        names = {0: 'kick', 1: 'snare', 2: 'hihat', 3: 'tom', 4: 'cymbal'}
        for lane, name in names.items():
            ref_hits = [(t, i) for i, t in enumerate(r_ticks) if lane in r_lanes[t]]
            cand_hits = [(t, j) for j, t in enumerate(c_ticks) if lane in c_lanes[t]]
            lp = match_times([r_t[i] for _, i in ref_hits], [c_t[j] for _, j in cand_hits], tol_s)
            per_lane[name] = {**_prf(len(lp), len(ref_hits), len(cand_hits)),
                              'ref': len(ref_hits), 'cand': len(cand_hits)}
        out['lanes'] = per_lane
        if pairs:
            exact = sum(1 for i, j in pairs if r_lanes[r_ticks[i]] == c_lanes[c_ticks[j]])
            out['lane_set_accuracy'] = round(exact / len(pairs), 4)
        out['self_consistency'] = self_consistency(
            [(t, tuple(sorted(c_lanes[t]))) for t in c_ticks], cand.bar_ticks())
        r_dur = max(r_t[-1] - r_t[0], 1e-6) if r_t else 1.0
        c_dur = max(c_t[-1] - c_t[0], 1e-6) if c_t else 1.0
    else:
        r_lanes2 = guitar_rows_to_lanes(ref_rows)
        c_lanes2 = guitar_rows_to_lanes(cand_rows)
        r_ticks, c_ticks = sorted(r_lanes2), sorted(c_lanes2)
        r_t = [ref.seconds(t) for t in r_ticks]
        c_t = [cand.seconds(t) for t in c_ticks]
        pairs = match_times(r_t, c_t, tol_s)
        out['onsets'] = _prf(len(pairs), len(r_t), len(c_t))

        def _anchor(frets: set[int]) -> int:
            gems = sorted(f for f in frets if f != 7)
            return gems[0] if gems else -1

        agree = total = 0
        for (i0, j0), (i1, j1) in zip(pairs, pairs[1:]):
            dr = _anchor(r_lanes2[r_ticks[i1]]['frets']) - _anchor(r_lanes2[r_ticks[i0]]['frets'])
            dc = _anchor(c_lanes2[c_ticks[j1]]['frets']) - _anchor(c_lanes2[c_ticks[j0]]['frets'])
            total += 1
            if (dr > 0) == (dc > 0) and (dr < 0) == (dc < 0):
                agree += 1
        out['contour_agreement'] = round(agree / total, 4) if total else None
        if pairs:
            same = sum(1 for i, j in pairs if r_lanes2[r_ticks[i]]['frets'] == c_lanes2[c_ticks[j]]['frets'])
            out['exact_lane_accuracy'] = round(same / len(pairs), 4)
        out['self_consistency'] = self_consistency(
            [(t, tuple(sorted(c_lanes2[t]['frets']))) for t in c_ticks], cand.bar_ticks())
        out['chord_rate'] = {
            'reference': round(sum(1 for t in r_ticks if len(r_lanes2[t]['frets']) > 1) / len(r_ticks), 4) if r_ticks else 0.0,
            'candidate': round(sum(1 for t in c_ticks if len(c_lanes2[t]['frets']) > 1) / len(c_ticks), 4) if c_ticks else 0.0,
        }
        out['sustain_rate'] = {
            'reference': round(sum(1 for t in r_ticks if r_lanes2[t]['sustain'] > 0) / len(r_ticks), 4) if r_ticks else 0.0,
            'candidate': round(sum(1 for t in c_ticks if c_lanes2[t]['sustain'] > 0) / len(c_ticks), 4) if c_ticks else 0.0,
        }
        r_dur = max(r_t[-1] - r_t[0], 1e-6) if r_t else 1.0
        c_dur = max(c_t[-1] - c_t[0], 1e-6) if c_t else 1.0
    out['density_per_sec'] = {
        'reference': round(len(r_t) / r_dur, 3) if r_t else 0.0,
        'candidate': round(len(c_t) / c_dur, 3) if c_t else 0.0,
    }
    out['counts'] = {'reference': len(r_t), 'candidate': len(c_t), 'matched': len(pairs)}
    return out


def _section_for(chart: Chart, difficulty: str, drums: bool | None) -> str | None:
    for name in chart.sections:
        if not name.startswith(difficulty):
            continue
        if drums is None or is_drum_section(name) == drums:
            return name
    return None


def evaluate_charts(ref_text: str, cand_text: str, tol_ms: float = 50.0,
                    drums: bool | None = None) -> dict[str, Any]:
    """Evaluate every difficulty present in both charts. `drums` restricts
    to drum (True) or non-drum (False) sections; None = whatever the
    reference has first."""
    ref, cand = parse_chart(ref_text), parse_chart(cand_text)
    if drums is None:
        first = next(iter(ref.sections), '')
        drums = is_drum_section(first)
    result: dict[str, Any] = {'tolerance_ms': tol_ms, 'difficulties': {}}
    for diff in DIFFICULTIES:
        r_name = _section_for(ref, diff, drums)
        c_name = _section_for(cand, diff, drums)
        if r_name is None or c_name is None:
            continue
        result['difficulties'][diff] = evaluate_section(ref, cand, r_name, c_name, tol_ms / 1000.0)
    exp = result['difficulties'].get('Expert')
    if exp:
        result['summary'] = {
            'expert_onset_f1': exp['onsets']['f1'],
            'expert_lane_score': exp.get('lane_set_accuracy', exp.get('contour_agreement')),
            'expert_self_consistency': exp.get('self_consistency'),
        }
    return result


def format_report(result: dict[str, Any]) -> str:
    lines = [f"tolerance ±{result['tolerance_ms']:.0f} ms"]
    for diff, r in result['difficulties'].items():
        o = r['onsets']
        lines.append(f"{diff:7s} onsets P={o['precision']:.2f} R={o['recall']:.2f} F1={o['f1']:.2f}  "
                     f"n ref/cand/matched={r['counts']['reference']}/{r['counts']['candidate']}/{r['counts']['matched']}  "
                     f"density ref/cand={r['density_per_sec']['reference']:.2f}/{r['density_per_sec']['candidate']:.2f}")
        if r['drums']:
            lanes = '  '.join(f"{k}:F1={v['f1']:.2f}({v['ref']}/{v['cand']})" for k, v in r['lanes'].items())
            lines.append(f"        lanes {lanes}")
            lines.append(f"        lane-set acc={r.get('lane_set_accuracy')}  self-consistency={r.get('self_consistency')}")
        else:
            lines.append(f"        contour={r.get('contour_agreement')}  exact-lane={r.get('exact_lane_accuracy')}  "
                         f"self-consistency={r.get('self_consistency')}  chords ref/cand="
                         f"{r['chord_rate']['reference']:.2f}/{r['chord_rate']['candidate']:.2f}  sustains ref/cand="
                         f"{r['sustain_rate']['reference']:.2f}/{r['sustain_rate']['candidate']:.2f}")
    return '\n'.join(lines)
