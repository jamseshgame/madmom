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
import shutil
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

SAMPLE_RATE = 44100
NOTE_DURATION_S = 2.0  # game client fades to ~150ms for single-hit notes

# Pre-rendered pack store — populated by scripts/render_sample_packs.py once
# per pack/scale combo. Files committed to the repo, served as-is.
_PRERENDERED_DIR = Path(__file__).resolve().parents[2] / 'sample_packs_data'

# SF2 (high-quality, GM-aware) fallback. fluidsynth + a GM soundfont must be
# installed on the host. Standard apt install drops FluidR3_GM.sf2 at this
# path; the constants below are the lookup the renderer tries in order.
_SF2_CANDIDATES = (
    '/usr/share/sounds/sf2/FluidR3_GM.sf2',
    '/usr/share/sounds/sf2/default-GM.sf2',
    '/usr/share/soundfonts/FluidR3_GM.sf2',
)


def _resolve_sf2() -> Path | None:
    for p in _SF2_CANDIDATES:
        if Path(p).exists():
            return Path(p)
    return None


def _have_fluidsynth() -> bool:
    return shutil.which('fluidsynth') is not None and _resolve_sf2() is not None


@dataclass(frozen=True)
class Pack:
    pack_id: str        # url-safe key
    name: str           # display label
    family: str         # 'guitar' | 'bass' | 'keys'
    description: str    # short blurb shown in the UI
    # General MIDI program number (1-indexed, GM standard). 25 = Acoustic
    # Guitar (Nylon), 26 = Steel, 28 = Electric Clean, 30 = Overdrive,
    # 31 = Distortion, 34 = Bass Finger, 35 = Bass Pick, etc. When SF2
    # rendering is available (fluidsynth + FluidR3_GM.sf2) the renderer
    # uses this; otherwise it falls back to the Karplus-Strong params.
    gm_program: int = 25
    # Karplus-Strong params — used only if SF2 rendering isn't available
    # (e.g. local Windows dev). damping in (0.4, 0.5); closer to 0.5 =
    # brighter / longer sustain. brightness pre-rolls the initial noise
    # burst toward the highs (electric/distortion).
    damping: float = 0.495
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
        gm_program=25,
        damping=0.495, brightness=0.05, drive=0.0,
        attack_s=0.008, decay_tau_s=1.8,
    ),
    'acoustic-steel': Pack(
        pack_id='acoustic-steel',
        name='Acoustic Guitar (Steel)',
        family='guitar',
        description='Bright steel-string acoustic. Snappy attack.',
        gm_program=26,
        damping=0.498, brightness=0.25, drive=0.0,
        attack_s=0.004, decay_tau_s=1.6,
    ),
    'electric-clean': Pack(
        pack_id='electric-clean',
        name='Electric Guitar (Clean)',
        family='guitar',
        description='Clean electric — high-string emphasis, tight decay.',
        gm_program=28,
        damping=0.49, brightness=0.45, drive=0.5,
        attack_s=0.003, decay_tau_s=1.3,
    ),
    'electric-overdrive': Pack(
        pack_id='electric-overdrive',
        name='Electric Guitar (Overdrive)',
        family='guitar',
        description='Overdriven electric — Rock/Punk rhythm.',
        gm_program=30,
        damping=0.495, brightness=0.35, drive=2.5,
        attack_s=0.002, decay_tau_s=1.5,
    ),
    'electric-distortion': Pack(
        pack_id='electric-distortion',
        name='Electric Guitar (Distortion)',
        family='guitar',
        description='Heavy distortion lead/rhythm — Metal/Hard rock.',
        gm_program=31,
        damping=0.495, brightness=0.55, drive=4.0,
        attack_s=0.002, decay_tau_s=1.4,
    ),
    'bass-finger': Pack(
        pack_id='bass-finger',
        name='Bass Guitar (Finger)',
        family='bass',
        description='Finger-picked electric bass. Round low end.',
        gm_program=34,
        damping=0.499, brightness=0.0, drive=0.0,
        attack_s=0.01, decay_tau_s=1.9,
    ),
    'bass-pick': Pack(
        pack_id='bass-pick',
        name='Bass Guitar (Pick)',
        family='bass',
        description='Pick-attack electric bass. Crisper transients than finger.',
        gm_program=35,
        damping=0.498, brightness=0.15, drive=0.0,
        attack_s=0.005, decay_tau_s=1.7,
    ),
    'piano-acoustic': Pack(
        pack_id='piano-acoustic',
        name='Acoustic Piano',
        family='keys',
        description='Grand piano — fallback synth approximates it crudely.',
        gm_program=1,
        damping=0.499, brightness=0.1, drive=0.0,
        attack_s=0.003, decay_tau_s=2.2,
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


def _sf2_render_note(midi_note: int, gm_program: int, out_wav: Path,
                     note_dur_s: float = 1.6, tail_s: float = 0.4) -> None:
    """Render a single MIDI note via fluidsynth + FluidR3_GM.

    Builds an in-memory MIDI file with program-change + note-on + note-off +
    trailing silence, invokes fluidsynth in batch mode (`-ni`), and writes a
    WAV. Caller transcodes to OGG via _wav_to_ogg.
    """
    import mido
    sf2 = _resolve_sf2()
    if sf2 is None:
        raise RuntimeError('No GM SoundFont found; install fluid-soundfont-gm')

    mf = mido.MidiFile()
    track = mido.MidiTrack()
    mf.tracks.append(track)
    tick_per_s = 2 * mf.ticks_per_beat  # 120 BPM → 2 quarters/s
    track.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(120), time=0))
    track.append(mido.Message('program_change', program=gm_program - 1, time=0))
    track.append(mido.Message('note_on', note=midi_note, velocity=96, time=0))
    track.append(mido.Message('note_off', note=midi_note, velocity=0,
                              time=int(note_dur_s * tick_per_s)))
    track.append(mido.MetaMessage('end_of_track', time=int(tail_s * tick_per_s)))

    with tempfile.NamedTemporaryFile(suffix='.mid', delete=False) as tf:
        mid_path = tf.name
    try:
        mf.save(mid_path)
        out_wav.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            ['fluidsynth', '-ni', '-r', str(SAMPLE_RATE), '-g', '0.7',
             '-F', str(out_wav), str(sf2), mid_path],
            capture_output=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f'fluidsynth failed: {proc.stderr.decode("utf-8", errors="replace")[-300:]}'
            )
    finally:
        Path(mid_path).unlink(missing_ok=True)


def _wav_to_ogg(wav_path: Path, ogg_path: Path) -> None:
    proc = subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav_path),
         '-c:a', 'libvorbis', '-q:a', '4', str(ogg_path)],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f'ffmpeg failed: {proc.stderr.decode("utf-8", errors="replace")[-300:]}'
        )


def _mix_oggs(a_path: Path, b_path: Path, out_path: Path) -> None:
    """Mix two OGGs into a chord via ffmpeg amix. Used so SF2-rendered chords
    sound like real two-note guitar voicings (not synthesized stacks)."""
    proc = subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error',
         '-i', str(a_path), '-i', str(b_path),
         '-filter_complex', 'amix=inputs=2:duration=longest:normalize=0,volume=0.89',
         '-c:a', 'libvorbis', '-q:a', '4', str(out_path)],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f'ffmpeg amix failed: {proc.stderr.decode("utf-8", errors="replace")[-300:]}'
        )


def _render_pack_sf2(pack: Pack, scale: Scale, out_dir: Path) -> dict[str, str]:
    """Render a pack using fluidsynth + GM SoundFont. Higher quality than the
    Karplus-Strong fallback. Chord slots = stacked pairs of adjacent lanes,
    mixed via ffmpeg so the result sounds like a played chord."""
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='sf2pack-') as tmp:
        tmp_dir = Path(tmp)
        # 1. Render 6 single notes (5 lanes + 1 open).
        single_paths: dict[str, Path] = {}
        for i in range(5):
            wav = tmp_dir / f'lane_{i+1}.wav'
            _sf2_render_note(scale.midi[i], pack.gm_program, wav)
            ogg = out_dir / f'lane_{i+1}.ogg'
            _wav_to_ogg(wav, ogg)
            single_paths[f'lane_{i+1}'] = ogg
        # Open uses scale[5] (one step above the highest lane).
        wav = tmp_dir / 'open.wav'
        _sf2_render_note(scale.midi[5], pack.gm_program, wav)
        ogg = out_dir / 'open.ogg'
        _wav_to_ogg(wav, ogg)
        single_paths['open'] = ogg
        # 2. Build chord slots by mixing already-rendered lane OGGs.
        for a, b in ((1, 2), (2, 3), (3, 4), (4, 5)):
            chord_path = out_dir / f'chord_{a}{b}.ogg'
            _mix_oggs(single_paths[f'lane_{a}'], single_paths[f'lane_{b}'], chord_path)
    return {slot: f'{slot}.ogg' for slot in SLOT_ORDER}


def _render_pack_synth(pack: Pack, scale: Scale, out_dir: Path) -> dict[str, str]:
    """Pure-Python Karplus-Strong fallback (no fluidsynth dependency)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    base = [_karplus_strong(pack, midi) for midi in scale.midi[:5]]
    slot_to_audio: dict[str, np.ndarray] = {}
    for i in range(5):
        slot_to_audio[SLOT_ORDER[i]] = base[i]
    slot_to_audio['chord_12'] = _mix_chord(base[0], base[1])
    slot_to_audio['chord_23'] = _mix_chord(base[1], base[2])
    slot_to_audio['chord_34'] = _mix_chord(base[2], base[3])
    slot_to_audio['chord_45'] = _mix_chord(base[3], base[4])
    slot_to_audio['open'] = _karplus_strong(pack, scale.midi[5])
    for slot in SLOT_ORDER:
        _samples_to_ogg(slot_to_audio[slot], out_dir / f'{slot}.ogg')
    return {slot: f'{slot}.ogg' for slot in SLOT_ORDER}


def prerendered_path(pack_id: str, scale_id: str) -> Path | None:
    """Return the directory holding the 10 OGGs for this combo if pre-rendered.
    Pre-rendered packs ship in the repo under
    `web/backend/sample_packs_data/<pack>/<scale>/`."""
    d = _PRERENDERED_DIR / pack_id / scale_id
    if d.is_dir() and all((d / f'{slot}.ogg').exists() for slot in SLOT_ORDER):
        return d
    return None


def render_pack(pack: Pack, scale: Scale, out_dir: Path) -> dict[str, str]:
    """Materialize all 10 slot OGGs for `pack`+`scale` into `out_dir`.

    Strategy:
      1. If a pre-rendered bundle exists for this combo, copy it (fastest,
         best quality — the SF2-rendered bundles shipped in the repo).
      2. Else if fluidsynth + a GM SoundFont are available, render fresh via
         _render_pack_sf2 (acceptable when the user adds a new combo at
         runtime that wasn't pre-rendered).
      3. Else fall back to the Karplus-Strong synth (works on every host,
         lower quality — primarily for local Windows dev).

    Returns a mapping of slot → relative filename for writing into
    song.ini as `sample_<slot> = tutorial_samples/<filename>`.
    """
    if len(SLOT_ORDER) != 10:
        raise AssertionError('SLOT_ORDER must be exactly 10 entries')

    prerendered = prerendered_path(pack.pack_id, scale.scale_id)
    if prerendered is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        for slot in SLOT_ORDER:
            src = prerendered / f'{slot}.ogg'
            dst = out_dir / f'{slot}.ogg'
            shutil.copyfile(src, dst)
        return {slot: f'{slot}.ogg' for slot in SLOT_ORDER}

    if _have_fluidsynth():
        return _render_pack_sf2(pack, scale, out_dir)

    return _render_pack_synth(pack, scale, out_dir)


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
