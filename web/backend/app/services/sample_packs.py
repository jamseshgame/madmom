"""Real-notes sample packs — render 10-slot pitched samples for a track.

The chart spec (web/docs/TUTORIAL_SPEC.md §2) already defines a 10-slot sample
layout (`lane_1..lane_5`, `chord_12..chord_45`, `open`) that the game plays
back when a note is hit. Tutorial mode shipped with manual per-track sample
upload. "Real notes" mode reuses the same slot layout for non-tutorial play
and adds a curated pack library so charters don't have to source samples.

Two axes:
  - TIMBRE (acoustic nylon, acoustic steel, electric clean, bass) — a pack.
  - SCALE (C major pentatonic, A minor pentatonic, …) — chosen at apply time.

A pack defines how to synthesize a single pitched note (Karplus-Strong with
per-pack damping / brightness / decay). At apply time the user picks a scale
and we render 10 OGGs into the track's stems_dir/tutorial_samples/ using the
chosen scale's 10 MIDI pitches.

Slot → scale-note mapping:
  lane_1..lane_5 = scale notes 0..4 (ascending)
  chord_12..chord_45 = mixed pair (lane_x + lane_y) — a 2-voice chord that
    stays in scale, so adjacent lanes hit simultaneously still sound musical
  open = scale note 5 (high voice — provides melodic contrast)

Pure NumPy + ffmpeg for OGG encoding. No external SoundFont dependency.
Renders ~100ms per note on a typical laptop, ~1s per full pack.
"""
from __future__ import annotations

import io
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

SAMPLE_RATE = 44100
NOTE_DURATION_S = 2.0  # game client fades to ~150ms for single-hit notes


@dataclass(frozen=True)
class Pack:
    pack_id: str        # url-safe key
    name: str           # display label
    family: str         # 'guitar' | 'bass' | 'keys'
    description: str    # short blurb shown in the UI
    # Karplus-Strong params — tuned per timbre. damping in (0.4, 0.5);
    # closer to 0.5 = brighter / longer sustain. brightness pre-rolls the
    # initial noise burst toward the highs (electric/distortion).
    damping: float
    brightness: float = 0.0
    # tanh-saturation drive: 0 = clean, >2 starts to crunch.
    drive: float = 0.0
    # Attack envelope (seconds). Plucked strings have ~5ms.
    attack_s: float = 0.005
    # Decay curve — multiplies the synth output by exp(-t/decay_tau_s).
    decay_tau_s: float = 1.6


@dataclass(frozen=True)
class Scale:
    scale_id: str
    name: str
    description: str
    # 10 MIDI note numbers (C4 = 60). The first 5 map to lane_1..lane_5;
    # next 4 are combined into chord pairs; the last is `open`.
    midi: tuple[int, ...]

    def __post_init__(self) -> None:
        if len(self.midi) != 10:
            raise ValueError(f'scale needs 10 pitches, got {len(self.midi)}')


# ── Pack catalog ──────────────────────────────────────────────────────────
# Tuned by ear via Karplus-Strong on a 16-bar test run; each pack should
# read as a different instrument without any post-processing on the game
# side. If the user later drops in SF2-rendered samples we keep the same
# pack_id but swap the synth call for a sampled lookup.

PACKS: dict[str, Pack] = {
    'acoustic-nylon': Pack(
        pack_id='acoustic-nylon',
        name='Acoustic Guitar (Nylon)',
        family='guitar',
        description='Soft nylon-string acoustic. Warm pluck, gentle decay.',
        damping=0.495,
        brightness=0.05,
        drive=0.0,
        attack_s=0.008,
        decay_tau_s=1.8,
    ),
    'acoustic-steel': Pack(
        pack_id='acoustic-steel',
        name='Acoustic Guitar (Steel)',
        family='guitar',
        description='Bright steel-string acoustic. Snappy attack.',
        damping=0.498,
        brightness=0.25,
        drive=0.0,
        attack_s=0.004,
        decay_tau_s=1.6,
    ),
    'electric-clean': Pack(
        pack_id='electric-clean',
        name='Electric Guitar (Clean)',
        family='guitar',
        description='Clean electric — high-string emphasis, tight decay.',
        damping=0.49,
        brightness=0.45,
        drive=0.5,
        attack_s=0.003,
        decay_tau_s=1.3,
    ),
    'electric-overdrive': Pack(
        pack_id='electric-overdrive',
        name='Electric Guitar (Overdrive)',
        family='guitar',
        description='Overdriven electric — soft tanh saturation, longer tail.',
        damping=0.495,
        brightness=0.35,
        drive=2.5,
        attack_s=0.002,
        decay_tau_s=1.5,
    ),
    'bass-finger': Pack(
        pack_id='bass-finger',
        name='Bass Guitar (Finger)',
        family='bass',
        description='Finger-picked electric bass. Round low end.',
        damping=0.499,
        brightness=0.0,
        drive=0.0,
        attack_s=0.01,
        decay_tau_s=1.9,
    ),
}


# ── Scales ────────────────────────────────────────────────────────────────
# Pentatonic scales avoid semitone clashes — any two of the 10 pitches sound
# consonant when stacked, which matters because chord_xy slots mix two of
# them. Major-pentatonic spans C4–A5 (lights), minor-pentatonic spans A3–G5
# (darker / rock-ier).

SCALES: dict[str, Scale] = {
    'c-major-pentatonic': Scale(
        scale_id='c-major-pentatonic',
        name='C major pentatonic (2 octaves)',
        description='Bright, "always pleasant" — C4 D4 E4 G4 A4 C5 D5 E5 G5 A5.',
        midi=(60, 62, 64, 67, 69, 72, 74, 76, 79, 81),
    ),
    'a-minor-pentatonic': Scale(
        scale_id='a-minor-pentatonic',
        name='A minor pentatonic (2 octaves)',
        description='Darker / rock-blues — A3 C4 D4 E4 G4 A4 C5 D5 E5 G5.',
        midi=(57, 60, 62, 64, 67, 69, 72, 74, 76, 79),
    ),
    'e-minor-pentatonic': Scale(
        scale_id='e-minor-pentatonic',
        name='E minor pentatonic (2 octaves)',
        description='Classic guitar / metal — E3 G3 A3 B3 D4 E4 G4 A4 B4 D5.',
        midi=(52, 55, 57, 59, 62, 64, 67, 69, 71, 74),
    ),
    'd-major-pentatonic': Scale(
        scale_id='d-major-pentatonic',
        name='D major pentatonic (2 octaves)',
        description='Common open-string-guitar key — D4 E4 F#4 A4 B4 D5 E5 F#5 A5 B5.',
        midi=(62, 64, 66, 69, 71, 74, 76, 78, 81, 83),
    ),
}


# Slot order matches TUTORIAL_SPEC.md §2 "Sample slot → chart-note semantics".
# Index in SLOT_ORDER pairs each slot with its source scale-note index(es).
SLOT_ORDER = ('lane_1', 'lane_2', 'lane_3', 'lane_4', 'lane_5',
              'chord_12', 'chord_23', 'chord_34', 'chord_45', 'open')


# ── Synthesis ─────────────────────────────────────────────────────────────

def _midi_to_hz(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _karplus_strong(pack: Pack, midi: int) -> np.ndarray:
    """Render a single sustained note as float32 mono samples in [-1, 1].

    Standard Karplus-Strong: feed a noise burst into a circular delay line
    of length ≈ SR/freq, low-pass it on each pass (the `damping` average
    between adjacent slots), output the head, advance. Adds:
      - per-pack `brightness` pre-emphasis on the seed (high-pass-like)
      - tanh `drive` saturation (overdrive)
      - exponential decay envelope
      - short raised-cosine attack
    """
    freq = _midi_to_hz(midi)
    n_samples = int(NOTE_DURATION_S * SAMPLE_RATE)
    delay_len = max(2, int(round(SAMPLE_RATE / freq)))

    # Initial pluck: white noise. Brightness pre-emphasis emulates a
    # closer-to-bridge pick position (electric-guitar sound).
    rng = np.random.default_rng(seed=midi * 9973)  # deterministic per pitch
    seed = rng.uniform(-1.0, 1.0, delay_len).astype(np.float32)
    if pack.brightness > 0:
        for i in range(1, delay_len):
            seed[i] = seed[i] - pack.brightness * seed[i - 1]
        # Normalize after pre-emphasis so total energy doesn't drop
        peak = float(np.max(np.abs(seed)))
        if peak > 1e-9:
            seed /= peak

    buf = seed.copy()
    out = np.empty(n_samples, dtype=np.float32)
    damping = float(pack.damping)
    for i in range(n_samples):
        idx = i % delay_len
        nxt = (i + 1) % delay_len
        out[i] = buf[idx]
        # damping in (0.4, 0.5) = subtle low-pass; closer to 0.5 = brighter
        buf[idx] = damping * buf[idx] + (1.0 - damping) * buf[nxt]

    # Soft saturation (overdrive).
    if pack.drive > 0:
        out = np.tanh(out * (1.0 + pack.drive)).astype(np.float32)

    # Exponential decay envelope so notes fade naturally (no abrupt cut).
    t = np.arange(n_samples, dtype=np.float32) / SAMPLE_RATE
    out *= np.exp(-t / max(0.1, pack.decay_tau_s))

    # Short attack ramp prevents click on note onset.
    attack_n = max(1, int(pack.attack_s * SAMPLE_RATE))
    if attack_n < n_samples:
        ramp = 0.5 * (1.0 - np.cos(np.pi * np.arange(attack_n) / attack_n))
        out[:attack_n] *= ramp.astype(np.float32)

    # Final peak-normalize. Leave 1 dB headroom so mix-on-chord doesn't clip.
    peak = float(np.max(np.abs(out)))
    if peak > 1e-9:
        out *= (0.89 / peak)
    return out


def _mix_chord(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Stack two pitches into a 2-voice chord, peak-normalized."""
    n = min(a.shape[0], b.shape[0])
    mixed = (a[:n] + b[:n]) * 0.5
    peak = float(np.max(np.abs(mixed)))
    if peak > 1e-9:
        mixed = mixed * (0.89 / peak)
    return mixed.astype(np.float32)


def _samples_to_ogg(samples: np.ndarray, out_path: Path) -> None:
    """Encode float32 mono [-1, 1] → OGG Vorbis via ffmpeg piping.

    We stage to in-memory WAV first (wave stdlib, no extra deps) and pipe
    that into ffmpeg with `-i pipe:0`. Avoids a temp file per note.
    """
    int16 = np.clip(samples, -1.0, 1.0)
    int16 = (int16 * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(int16.tobytes())
    wav_bytes = buf.getvalue()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-f', 'wav', '-i', 'pipe:0',
            '-c:a', 'libvorbis', '-q:a', '4',
            str(out_path),
        ],
        input=wav_bytes,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f'ffmpeg failed encoding {out_path.name}: '
            f'{proc.stderr.decode("utf-8", errors="replace")[-300:]}'
        )


def render_pack(pack: Pack, scale: Scale, out_dir: Path) -> dict[str, str]:
    """Render every slot for `pack`+`scale` into `out_dir/<slot>.ogg`.

    Returns a mapping of slot → relative filename suitable for writing to
    song.ini as `sample_<slot> = tutorial_samples/<filename>`.
    """
    if len(SLOT_ORDER) != 10:
        raise AssertionError('SLOT_ORDER must be exactly 10 entries')
    out_dir.mkdir(parents=True, exist_ok=True)
    # Synthesize the 5 base scale notes once; reuse for chord mixes.
    base = [_karplus_strong(pack, midi) for midi in scale.midi[:5]]

    slot_to_audio: dict[str, np.ndarray] = {}
    # lane_1..lane_5 -> base notes 0..4
    for i in range(5):
        slot_to_audio[SLOT_ORDER[i]] = base[i]
    # chord_12, chord_23, chord_34, chord_45 -> stacked pairs of adjacent lanes
    slot_to_audio['chord_12'] = _mix_chord(base[0], base[1])
    slot_to_audio['chord_23'] = _mix_chord(base[1], base[2])
    slot_to_audio['chord_34'] = _mix_chord(base[2], base[3])
    slot_to_audio['chord_45'] = _mix_chord(base[3], base[4])
    # open = scale note index 5 (one step above the highest lane)
    slot_to_audio['open'] = _karplus_strong(pack, scale.midi[5])

    rel_paths: dict[str, str] = {}
    for slot in SLOT_ORDER:
        filename = f'{slot}.ogg'
        _samples_to_ogg(slot_to_audio[slot], out_dir / filename)
        rel_paths[slot] = filename
    return rel_paths


# ── Catalog helpers (for the router) ──────────────────────────────────────

def pack_catalog() -> list[dict]:
    return [
        {
            'pack_id': p.pack_id,
            'name': p.name,
            'family': p.family,
            'description': p.description,
        }
        for p in PACKS.values()
    ]


def scale_catalog() -> list[dict]:
    return [
        {
            'scale_id': s.scale_id,
            'name': s.name,
            'description': s.description,
            'midi': list(s.midi),
        }
        for s in SCALES.values()
    ]


def get_pack(pack_id: str) -> Pack | None:
    return PACKS.get(pack_id)


def get_scale(scale_id: str) -> Scale | None:
    return SCALES.get(scale_id)
