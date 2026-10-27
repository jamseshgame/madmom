#!/usr/bin/env python3
"""Reference-free timing check: how far a drum chart's notes sit from the
hit transients in its own audio.

    python scripts/check_timing.py BEATMAP.zip [BEATMAP2.zip ...]

For each note the nearest transient (log-spectral flux peak, kicks in the
low band, everything else full band) within ±60 ms is found; the report is
the median and spread of (note − transient) per lane. Negative = notes
early, positive = late. Harmonix charts measure within −1…+5 ms on this
metric; uncalibrated madmom grids measured −26…−30 ms.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.pipeline.audio_io import load_audio  # noqa: E402
from app.services.pipeline.evaluate import parse_chart  # noqa: E402

LANES = {0: 'kick', 1: 'snare', 2: 'yellow', 3: 'blue', 4: 'green'}


def _flux(y: np.ndarray, sr: int, lo: float | None = None, hi: float | None = None):
    from scipy.signal import stft
    hop = 64
    f, _t, Z = stft(y, fs=sr, nperseg=512, noverlap=512 - hop, boundary='zeros', padded=True)
    mask = np.ones(len(f), bool)
    if lo is not None:
        mask &= f >= lo
    if hi is not None:
        mask &= f < hi
    L = np.log1p(50 * np.abs(Z[mask])).sum(0)
    return np.maximum(np.diff(L, prepend=L[:1]), 0), hop / sr


def offsets_ms(times: list[float], flux: np.ndarray, hop_s: float, win_s: float = 0.06) -> np.ndarray:
    strong = np.percentile(flux[flux > 0], 60) if np.any(flux > 0) else 0
    out = []
    w = int(round(win_s / hop_s))
    for t in times:
        c = int(round(t / hop_s))
        a, b = c - w, c + w + 1
        if a < 0 or b > len(flux):
            continue
        seg = flux[a:b]
        k = int(np.argmax(seg))
        if seg[k] < strong:
            continue
        out.append((t - (a + k) * hop_s) * 1000)
    return np.asarray(out)


def check(path: Path, workdir: Path) -> None:
    if path.suffix.lower() == '.zip':
        folder = workdir / path.stem
        with zipfile.ZipFile(path) as zf:
            zf.extractall(folder)
    else:
        folder = path
    chart = next(p for p in folder.rglob('*.chart') if '__MACOSX' not in p.parts and not p.name.startswith('._'))
    audio = next(p for p in chart.parent.iterdir() if p.suffix.lower() in ('.ogg', '.wav', '.mp3', '.flac') and not p.name.startswith('._'))
    C = parse_chart(chart.read_text(encoding='utf-8', errors='replace'))
    section = next(s for s in C.sections if s.startswith('Expert'))
    y, sr = load_audio(audio, target_sr=22050, mono=True)
    full, hop_s = _flux(y, sr)
    low, _ = _flux(y, sr, 30, 150)
    print(f'== {path.name}  ({section}, {audio.name})')
    by_lane: dict[int, list[float]] = {}
    for tick, note, _s in C.sections[section]:
        if note in LANES:
            by_lane.setdefault(note, []).append(C.seconds(tick))
    all_off = []
    for lane, name in LANES.items():
        times = sorted(set(by_lane.get(lane, [])))
        if len(times) < 10:
            continue
        off = offsets_ms(times, low if lane == 0 else full, hop_s)
        if len(off) < 10:
            continue
        all_off.extend(off.tolist())
        print(f'   {name:7s} n={len(off):4d}  note − transient: median {np.median(off):+6.1f} ms   p10 {np.percentile(off, 10):+6.1f}   p90 {np.percentile(off, 90):+6.1f}')
    if all_off:
        med = float(np.median(all_off))
        verdict = 'on the transients' if abs(med) <= 8 else ('EARLY' if med < 0 else 'LATE')
        print(f'   overall median {med:+.1f} ms → {verdict}')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('beatmaps', nargs='+')
    args = ap.parse_args()
    work = Path(tempfile.mkdtemp(prefix='check_timing_'))
    for b in args.beatmaps:
        check(Path(b), work)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
