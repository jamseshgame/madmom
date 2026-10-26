"""Reading reference charts for evaluation: Clone Hero `.sng` containers,
Rock Band style `notes.mid`, and plain `.chart`.

Human-made charts come as a folder (notes.chart/notes.mid + audio), a zip
of one, or a `.sng`. This module turns any of those into
``ReferenceSong(chart_text, audio_path, meta)`` so `evaluate` can score an
auto chart against it, and converts MIDI drum parts into `.chart` text
with Pro Drums modifiers so one scorer handles both formats.

Pure Python; audio is only extracted, never decoded here.
"""
from __future__ import annotations

import struct
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Rock Band drum pitches: base per difficulty, +0 kick … +4 green.
MIDI_DRUM_BASE = {'Expert': 96, 'Hard': 84, 'Medium': 72, 'Easy': 60}
# RB3 Pro Drums tom markers (yellow/blue/green). Note: in MIDI the marker
# means *tom*; in .chart the 66/67/68 modifier means *cymbal*.
MIDI_TOM_MARKERS = {110: 2, 111: 3, 112: 4}
CHART_CYMBAL_MOD = {2: 66, 3: 67, 4: 68}
AUDIO_EXTS = ('.opus', '.ogg', '.mp3', '.wav', '.flac', '.m4a')


@dataclass
class ReferenceSong:
    chart_text: str
    audio_path: Path | None
    drum_stems: list[Path] = field(default_factory=list)
    meta: dict[str, str] = field(default_factory=dict)
    source: str = ''
    pro_drums: bool | None = None  # None = unknown / not a MIDI source
    workdir: Path | None = None


# ── .sng (Clone Hero / YARG song container, v1) ──────────────────────────

def unpack_sng(path: Path, out_dir: Path) -> dict[str, Any]:
    """Unpack a v1 .sng: 'SNGPKG', u32 version, 16-byte xor mask, metadata,
    file index, xor-masked file data (byte i ^ mask[i & 15] ^ (i & 0xFF))."""
    import numpy as np

    data = path.read_bytes()
    if data[:6] != b'SNGPKG':
        raise ValueError(f'{path.name} is not a .sng container')
    pos = 6
    version, = struct.unpack_from('<I', data, pos)
    pos += 4
    mask = np.frombuffer(data[pos:pos + 16], dtype=np.uint8)
    pos += 16
    pos += 8  # metadata section length
    n_meta, = struct.unpack_from('<Q', data, pos)
    pos += 8
    meta: dict[str, str] = {}
    for _ in range(n_meta):
        kl, = struct.unpack_from('<I', data, pos)
        pos += 4
        key = data[pos:pos + kl].decode(errors='replace')
        pos += kl
        vl, = struct.unpack_from('<I', data, pos)
        pos += 4
        meta[key] = data[pos:pos + vl].decode(errors='replace')
        pos += vl
    pos += 8  # index section length
    n_files, = struct.unpack_from('<Q', data, pos)
    pos += 8
    entries = []
    for _ in range(n_files):
        nl = data[pos]
        pos += 1
        name = data[pos:pos + nl].decode(errors='replace')
        pos += nl
        size, off = struct.unpack_from('<QQ', data, pos)
        pos += 16
        entries.append((name, size, off))
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, size, off in entries:
        raw = np.frombuffer(data[off:off + size], dtype=np.uint8)
        idx = np.arange(size, dtype=np.int64)
        dec = raw ^ mask[idx & 15] ^ (idx & 0xFF).astype(np.uint8)
        (out_dir / Path(name).name).write_bytes(dec.tobytes())
    (out_dir / 'song.ini').write_text('[song]\n' + ''.join(f'{k} = {v}\n' for k, v in meta.items()))
    return {'version': version, 'meta': meta, 'files': [e[0] for e in entries]}


# ── MIDI ─────────────────────────────────────────────────────────────────

def _read_var(b: bytes, p: int) -> tuple[int, int]:
    v = 0
    while True:
        c = b[p]
        p += 1
        v = (v << 7) | (c & 0x7F)
        if not c & 0x80:
            return v, p


def parse_midi(path: Path) -> tuple[int, list[dict[str, Any]]]:
    """Minimal SMF parser. Returns (division, tracks) where each track has
    name, notes [(start, end, pitch)], tempos [(tick, us_per_beat)],
    time_sigs [(tick, num, denom)], texts [(tick, text)]."""
    data = path.read_bytes()
    if data[:4] != b'MThd':
        raise ValueError(f'{path.name} is not a MIDI file')
    _fmt, ntrk, div = struct.unpack('>HHH', data[8:14])
    p = 14
    tracks = []
    for _ in range(ntrk):
        if data[p:p + 4] != b'MTrk':
            raise ValueError('bad MIDI track header')
        ln = struct.unpack('>I', data[p + 4:p + 8])[0]
        body = data[p + 8:p + 8 + ln]
        p += 8 + ln
        q = tick = status = 0
        name = ''
        notes: list[tuple[int, int, int]] = []
        tempos: list[tuple[int, int]] = []
        tss: list[tuple[int, int, int]] = []
        texts: list[tuple[int, str]] = []
        active: dict[int, int] = {}
        while q < len(body):
            d, q = _read_var(body, q)
            tick += d
            b = body[q]
            if b == 0xFF:
                typ = body[q + 1]
                l, q2 = _read_var(body, q + 2)
                pl = body[q2:q2 + l]
                q = q2 + l
                if typ == 3:
                    name = pl.decode(errors='replace')
                elif typ == 1:
                    texts.append((tick, pl.decode(errors='replace')))
                elif typ == 0x51:
                    tempos.append((tick, int.from_bytes(pl, 'big')))
                elif typ == 0x58:
                    tss.append((tick, pl[0], 2 ** pl[1]))
            elif b in (0xF0, 0xF7):
                l, q2 = _read_var(body, q + 1)
                q = q2 + l
            else:
                if b & 0x80:
                    status = b
                    q += 1
                hi = status & 0xF0
                if hi in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                    d1, d2 = body[q], body[q + 1]
                    q += 2
                    if hi == 0x90 and d2 > 0:
                        active[d1] = tick
                    elif hi in (0x80, 0x90) and d1 in active:
                        notes.append((active.pop(d1), tick, d1))
                else:
                    q += 1
        tracks.append({'name': name, 'notes': notes, 'tempos': tempos, 'time_sigs': tss, 'texts': texts})
    return div, tracks


# Rock Band 5-fret parts: same per-difficulty bases as drums; +0 green … +4
# orange. Sustains are the note length (RB cuts anything under a 16th to 0).
MIDI_FRET_TRACKS = {'guitar': 'PART GUITAR', 'bass': 'PART BASS', 'keys': 'PART KEYS', 'rhythm': 'PART RHYTHM'}
# Chart section suffix for each part (what the Jamsesh editor/publisher uses).
CHART_SUFFIX = {'drums': 'Drums', 'guitar': 'Single', 'bass': 'DoubleBass', 'keys': 'Keyboard', 'rhythm': 'DoubleRhythm'}


def _synctrack_text(div: int, tracks: list[dict[str, Any]], resolution: int) -> str:
    scale = resolution / div
    tempos = tracks[0]['tempos'] or [(0, 500_000)]
    tss = tracks[0]['time_sigs'] or [(0, 4, 4)]
    rows = [(int(round(t * scale)), f'TS {n}' if d == 4 else f'TS {n} {d.bit_length() - 1}') for t, n, d in tss]
    rows += [(int(round(t * scale)), f'B {int(round(60_000_000_000 / us))}') for t, us in tempos]
    rows.sort(key=lambda r: (r[0], 0 if r[1].startswith('TS') else 1))
    return (f'[Song]\n{{\n  Resolution = {resolution}\n}}\n[SyncTrack]\n{{\n'
            + ''.join(f'  {t} = {x}\n' for t, x in rows) + '}\n[Events]\n{\n}\n')


def midi_frets_to_chart(path: Path, part: str = 'guitar', resolution: int = 192) -> str:
    """Convert a Rock Band 5-fret part (PART GUITAR/BASS/KEYS) to .chart text
    with [Expert<Suffix>]…[Easy<Suffix>] sections. Sustain = note length in
    ticks when ≥ a 16th, else 0 (RB's own cutoff). Open notes (CH note 7)
    don't exist in RB MIDI."""
    div, tracks = parse_midi(path)
    scale = resolution / div
    name = MIDI_FRET_TRACKS[part]
    tr = next((t for t in tracks if t['name'].strip().upper() == name), None)
    if tr is None:
        raise ValueError(f'MIDI has no {name} track')
    min_sustain = resolution // 4
    out = [_synctrack_text(div, tracks, resolution)]
    suffix = CHART_SUFFIX[part]
    for diff, base in MIDI_DRUM_BASE.items():
        lines = []
        for s, e, pch in tr['notes']:
            if not base <= pch <= base + 4:
                continue
            tick = int(round(s * scale))
            length = int(round(e * scale)) - tick
            sustain = length if length >= min_sustain else 0
            lines.append((tick, pch - base, f'N {pch - base} {sustain}'))
        lines.sort()
        out.append(f'[{diff}{suffix}]\n{{\n' + ''.join(f'  {t} = {x}\n' for t, _, x in lines) + '}\n')
    return ''.join(out)


def midi_drums_to_chart(path: Path, resolution: int = 192) -> tuple[str, bool]:
    """Convert PART DRUMS of a Rock Band style MIDI to .chart text with
    [ExpertDrums]…[EasyDrums] sections in Pro Drums notation.

    Returns (chart_text, pro_drums). ``pro_drums`` is False when the MIDI
    carries no tom markers at all (4-lane era chart): the pads are then
    whatever Harmonix meant by them (yellow ≈ hi-hat, blue ≈ ride/toms,
    green ≈ crash/floor tom) and no cymbal modifiers are emitted, so
    evaluation should compare pads rather than tom-vs-cymbal.
    """
    div, tracks = parse_midi(path)
    scale = resolution / div

    def T(t: int) -> int:
        return int(round(t * scale))

    tempos = tracks[0]['tempos'] or [(0, 500_000)]
    tss = tracks[0]['time_sigs'] or [(0, 4, 4)]
    drums = next((t for t in tracks if t['name'].strip().upper() == 'PART DRUMS'), None)
    if drums is None:
        raise ValueError('MIDI has no PART DRUMS track')
    notes = drums['notes']
    markers = {m: [(s, e) for s, e, p in notes if p == m] for m in MIDI_TOM_MARKERS}
    pro = any(markers.values())

    def is_tom(pad: int, tick: int) -> bool:
        m = next((mm for mm, pp in MIDI_TOM_MARKERS.items() if pp == pad), None)
        return m is not None and any(s <= tick < e or s == tick for s, e in markers[m])

    out = [f'[Song]\n{{\n  Resolution = {resolution}\n}}\n', '[SyncTrack]\n{\n']
    rows = [(T(t), f'TS {n}' if d == 4 else f'TS {n} {d.bit_length() - 1}') for t, n, d in tss]
    rows += [(T(t), f'B {int(round(60_000_000_000 / us))}') for t, us in tempos]
    rows.sort(key=lambda r: (r[0], 0 if r[1].startswith('TS') else 1))
    out += [f'  {t} = {x}\n' for t, x in rows]
    out.append('}\n[Events]\n{\n}\n')
    for diff, base in MIDI_DRUM_BASE.items():
        lines = []
        for s, _e, pch in notes:
            if not base <= pch <= base + 4:
                continue
            pad = pch - base
            lines.append((T(s), pad, f'N {pad} 0'))
            if pro and pad in CHART_CYMBAL_MOD and not is_tom(pad, s):
                mod = CHART_CYMBAL_MOD[pad]
                lines.append((T(s), mod, f'N {mod} 0'))
        lines.sort()
        out.append(f'[{diff}Drums]\n{{\n' + ''.join(f'  {t} = {x}\n' for t, _, x in lines) + '}\n')
    return ''.join(out), pro


# ── loading any reference ────────────────────────────────────────────────

def _find(dirpath: Path, names: tuple[str, ...]) -> Path | None:
    for p in dirpath.rglob('*'):
        if p.is_file() and p.name.lower() in names:
            return p
    return None


def load_reference(path: Path, workdir: Path | None = None, part: str = 'drums') -> ReferenceSong:
    """Load a reference song from a .sng, a .zip, a folder, a .chart or a
    .mid. Extracted files go under `workdir` (a temp dir by default).
    `part` selects which MIDI part to convert ('drums', 'guitar', 'bass',
    'keys'); a .chart reference is used as-is."""
    path = Path(path)
    workdir = Path(workdir) if workdir else Path(tempfile.mkdtemp(prefix='refsong_'))
    if path.is_dir():
        folder = path
    elif path.suffix.lower() == '.sng':
        folder = workdir / path.stem
        unpack_sng(path, folder)
    elif path.suffix.lower() == '.zip':
        folder = workdir / path.stem
        with zipfile.ZipFile(path) as zf:
            zf.extractall(folder)
    elif path.suffix.lower() in ('.chart', '.mid', '.midi'):
        folder = path.parent
    else:
        raise ValueError(f'unsupported reference: {path}')

    chart_file = path if path.suffix.lower() in ('.chart', '.mid', '.midi') else \
        (_find(folder, ('notes.chart',)) or _find(folder, ('notes.mid', 'notes.midi')))
    if chart_file is None:
        raise ValueError(f'no notes.chart / notes.mid under {folder}')
    pro: bool | None = None
    if chart_file.suffix.lower() in ('.mid', '.midi'):
        if part == 'drums':
            text, pro = midi_drums_to_chart(chart_file)
        else:
            text = midi_frets_to_chart(chart_file, part)
    else:
        text = chart_file.read_text(encoding='utf-8', errors='replace')

    audio = None
    for cand in ('song', 'mix', 'preview'):
        for ext in AUDIO_EXTS:
            p = _find(folder, (cand + ext,))
            if p:
                audio = p
                break
        if audio:
            break
    stem_prefix = 'drums' if part == 'drums' else part
    drum_stems = sorted(p for p in folder.rglob('*') if p.is_file() and p.suffix.lower() in AUDIO_EXTS
                        and p.stem.lower().startswith(stem_prefix))
    meta: dict[str, str] = {}
    ini = _find(folder, ('song.ini',))
    if ini:
        for line in ini.read_text(encoding='utf-8', errors='replace').splitlines():
            if '=' in line and not line.strip().startswith('['):
                k, v = line.split('=', 1)
                meta[k.strip().lower()] = v.strip()
    return ReferenceSong(chart_text=text, audio_path=audio, drum_stems=drum_stems, meta=meta,
                         source=str(path), pro_drums=pro, workdir=workdir)
