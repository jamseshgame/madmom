"""Tests for the reference-chart readers, audio alignment and pad-level
drum comparison behind scripts/compare_chart.py."""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

from app.services.pipeline.align import align_flux, Alignment
from app.services.pipeline.evaluate import compare_drums, format_drum_report
from app.services.pipeline.reference_charts import (
    load_reference, midi_drums_to_chart, parse_midi, unpack_sng,
)


# ── MIDI fixture ─────────────────────────────────────────────────────────

def _var(n: int) -> bytes:
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append(0x80 | (n & 0x7F))
        n >>= 7
    return bytes(reversed(out))


def _track(events: list[tuple[int, bytes]]) -> bytes:
    body = b''
    last = 0
    for tick, ev in sorted(events, key=lambda e: e[0]):
        body += _var(tick - last) + ev
        last = tick
    body += _var(0) + b'\xff\x2f\x00'
    return b'MTrk' + struct.pack('>I', len(body)) + body


def _meta(typ: int, payload: bytes) -> bytes:
    return b'\xff' + bytes([typ]) + _var(len(payload)) + payload


def _note(pitch: int, on: bool) -> bytes:
    return bytes([0x90, pitch, 100 if on else 0])


def write_rb_midi(path: Path, pro: bool) -> None:
    """One bar of 4/4 at 120 BPM, division 480: kick+yellow on 1, snare on 2,
    yellow on 3, blue on 4 (Expert only). With `pro`, a tom marker (111)
    covers beat 4 so blue is a tom; yellow has no marker → cymbal."""
    tempo = _track([(0, _meta(3, b'tempo')), (0, _meta(0x51, (500_000).to_bytes(3, 'big'))),
                    (0, _meta(0x58, bytes([4, 2, 24, 8])))])
    ev = [(0, _meta(3, b'PART DRUMS'))]
    hits = [(0, 96), (0, 98), (480, 97), (960, 98), (1440, 99)]
    for t, p in hits:
        ev += [(t, _note(p, True)), (t + 60, _note(p, False))]
    if pro:
        ev += [(1440, _note(111, True)), (1500, _note(111, False))]
    drums = _track(ev)
    path.write_bytes(b'MThd' + struct.pack('>IHHH', 6, 1, 2, 480) + tempo + drums)


def test_parse_midi_and_convert_pro_drums(tmp_path):
    p = tmp_path / 'notes.mid'
    write_rb_midi(p, pro=True)
    div, tracks = parse_midi(p)
    assert div == 480 and [t['name'] for t in tracks] == ['tempo', 'PART DRUMS']
    text, pro = midi_drums_to_chart(p)
    assert pro is True
    assert '0 = B 120000' in text and '0 = TS 4' in text
    expert = text.split('[ExpertDrums]')[1].split('}')[0]
    rows = [ln.strip() for ln in expert.splitlines() if '=' in ln]
    # 480 MIDI ticks → 192 chart ticks per beat.
    assert '0 = N 0 0' in rows and '0 = N 2 0' in rows and '0 = N 66 0' in rows  # yellow = cymbal
    assert '192 = N 1 0' in rows
    assert '576 = N 3 0' in rows and '576 = N 67 0' not in rows                   # blue under tom marker
    assert '[EasyDrums]' in text


def test_convert_four_lane_midi_has_no_modifiers(tmp_path):
    p = tmp_path / 'notes.mid'
    write_rb_midi(p, pro=False)
    text, pro = midi_drums_to_chart(p)
    assert pro is False
    assert ' N 66 ' not in text and ' N 67 ' not in text and ' N 68 ' not in text


# ── .sng fixture ─────────────────────────────────────────────────────────

def write_sng(path: Path, files: dict[str, bytes], meta: dict[str, str]) -> None:
    mask = bytes(range(16))
    meta_blob = struct.pack('<Q', len(meta))
    for k, v in meta.items():
        meta_blob += struct.pack('<I', len(k)) + k.encode() + struct.pack('<I', len(v)) + v.encode()
    header_len = 6 + 4 + 16 + 8 + len(meta_blob) + 8
    index_blob = struct.pack('<Q', len(files))
    index_len = 8 + sum(1 + len(n) + 16 for n in files)
    data_start = header_len + index_len
    blobs = b''
    for name, content in files.items():
        off = data_start + len(blobs)
        index_blob += bytes([len(name)]) + name.encode() + struct.pack('<QQ', len(content), off)
        blobs += bytes(b ^ mask[i & 15] ^ (i & 0xFF) for i, b in enumerate(content))
    path.write_bytes(b'SNGPKG' + struct.pack('<I', 1) + mask + struct.pack('<Q', len(meta_blob)) + meta_blob
                     + struct.pack('<Q', index_len) + index_blob + blobs)


def test_unpack_sng_roundtrip(tmp_path):
    mid = tmp_path / 'src.mid'
    write_rb_midi(mid, pro=True)
    sng = tmp_path / 'song.sng'
    write_sng(sng, {'notes.mid': mid.read_bytes(), 'album.jpg': b'\x00' * 300}, {'name': 'T', 'artist': 'A'})
    info = unpack_sng(sng, tmp_path / 'out')
    assert info['meta'] == {'name': 'T', 'artist': 'A'}
    assert (tmp_path / 'out' / 'notes.mid').read_bytes() == mid.read_bytes()
    ref = load_reference(sng, tmp_path / 'work')
    assert ref.meta['name'] == 'T' and ref.pro_drums is True and '[ExpertDrums]' in ref.chart_text


def test_load_reference_from_plain_chart(tmp_path):
    c = tmp_path / 'notes.chart'
    c.write_text('[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}\n'
                 '[ExpertDrums]\n{\n  0 = N 0 0\n}\n')
    ref = load_reference(c)
    assert ref.pro_drums is None and '[ExpertDrums]' in ref.chart_text


# ── alignment ────────────────────────────────────────────────────────────

def test_align_flux_recovers_speed_and_lag():
    rng = np.random.default_rng(1)
    fps = 11025 / 110
    n = int(fps * 120)
    base = np.zeros(n, dtype=np.float32)
    # Irregular impulse train so the correlation has one clear peak.
    idx = np.cumsum(rng.integers(15, 60, size=400))
    idx = idx[idx < n - 1]
    base[idx] = 1.0
    base += 0.05 * rng.standard_normal(n).astype(np.float32)
    true_speed, true_lag = 1.0025, 3.2
    # Reference is a stretched + shifted copy: t_ref = t_auto/speed + lag.
    ref = np.zeros(int(fps * 135), dtype=np.float32)
    m = int(len(base) / true_speed)
    stretched = np.interp(np.linspace(0, len(base) - 1, m), np.arange(len(base)), base)
    start = int(true_lag * fps)
    ref[start:start + m] = stretched
    ref += 0.05 * rng.standard_normal(len(ref)).astype(np.float32)
    al = align_flux(base, ref)
    assert abs(al.speed - true_speed) < 0.0004
    assert abs(al.lag_s - true_lag) < 0.03
    assert al.reliable


def test_alignment_to_ref_mapping():
    al = Alignment(speed=2.0, lag_s=1.0, ncc=1.0, window_lag_std_ms=0.0, windows=5)
    assert al.to_ref(4.0) == 3.0


# ── pad-level comparison ─────────────────────────────────────────────────

def _chart(rows: list[str], section: str = 'ExpertDrums', bpm: int = 120000) -> str:
    body = '\n'.join(f'  {r}' for r in rows)
    return (f'[Song]\n{{\n  Resolution = 192\n}}\n[SyncTrack]\n{{\n  0 = TS 4\n  0 = B {bpm}\n}}\n'
            f'[Events]\n{{\n}}\n[{section}]\n{{\n{body}\n}}\n')


def test_compare_drums_pads_and_confusion():
    ref = _chart(['0 = N 0 0', '0 = N 2 0', '192 = N 1 0', '384 = N 2 0', '576 = N 3 0'])
    # Auto: hat on 1 missing (bleed rule), snare on 2 as blue, hat on 3 ok, blue on 4 as green.
    cand = _chart(['0 = N 0 0', '192 = N 3 0', '384 = N 2 0', '384 = N 66 0', '576 = N 4 0', '576 = N 68 0'],
                  section='ExpertSingle')
    res = compare_drums(ref, cand)
    exp = res['difficulties']['Expert']
    assert exp['onsets']['f1'] == 1.0
    assert exp['pads']['kick']['f1'] == 1.0
    assert exp['pads']['snare']['recall'] == 0.0 and exp['pads']['blue']['precision'] == 0.0
    assert exp['confusion']['snare'] == {'blue': 1}
    assert exp['confusion']['yellow'] == {'yellow': 1, 'missing': 1}
    assert exp['confusion']['blue'] == {'green': 1}
    assert res['summary']['expert_pad_f1']['kick'] == 1.0
    assert 'tempo grid' in format_drum_report(res)


def test_compare_drums_with_clock_transform():
    ref = _chart(['192 = N 1 0', '576 = N 1 0'])
    # Candidate on a clock that runs 2× fast and starts 0.5 s early:
    # t_ref = t_cand / 2 + 0.5 → cand ticks 0 and 768 (0.0 s, 2.0 s) ↔ ref 0.5 s, 1.5 s (ticks 192, 576).
    cand = _chart(['0 = N 1 0', '768 = N 1 0'], section='ExpertSingle')
    res = compare_drums(ref, cand, cand_to_ref_seconds=lambda s: s / 2 + 0.5)
    assert res['difficulties']['Expert']['onsets']['f1'] == 1.0
    res_unaligned = compare_drums(ref, cand)
    assert res_unaligned['difficulties']['Expert']['onsets']['f1'] < 1.0
