"""Shared basic-pitch inference + cache.

basic-pitch produces (onsets, pitches, polyphony) in a single forward pass.
S2's onset engine and S3's pitch engine both want this output, but rerunning
inference twice per stem is wasteful. We cache the per-stem result in
process memory keyed by (audio_path, mtime, params_signature).
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class BasicPitchResult:
    """Normalized output of basic-pitch inference.

    note_events: list of dicts with keys onset_s, offset_s, pitch_midi,
    amplitude. 'id' field added to each entry as a stable integer
    source_note_id.
    """
    note_events: list[dict[str, Any]]
    duration_s: float


_CACHE: dict[str, BasicPitchResult] = {}


def _key(audio_path: Path, params: dict[str, Any]) -> str:
    mtime = os.path.getmtime(audio_path)
    sig = json.dumps({'p': str(audio_path), 'm': mtime, 'params': params}, sort_keys=True)
    return hashlib.sha1(sig.encode()).hexdigest()


def run_basic_pitch(audio_path: Path, params: dict[str, Any]) -> BasicPitchResult:
    k = _key(audio_path, params)
    if k in _CACHE:
        return _CACHE[k]

    from basic_pitch.inference import predict
    model_output, midi_data, note_events = predict(
        str(audio_path),
        onset_threshold=float(params.get('onset_threshold', 0.5)),
        frame_threshold=float(params.get('pitch_confidence_threshold', 0.3)),
        minimum_note_length=float(params.get('min_note_length_ms', 50)),
    )

    norm: list[dict[str, Any]] = []
    for idx, ev in enumerate(note_events):
        # basic-pitch returns tuples: (start_s, end_s, pitch_midi, amplitude, pitch_bend)
        start_s, end_s, pitch_midi, amplitude, _pitch_bend = ev
        norm.append({
            'id': idx,
            'onset_s': float(start_s),
            'offset_s': float(end_s),
            'pitch_midi': int(pitch_midi),
            'amplitude': float(amplitude),
        })

    from .audio_io import load_audio
    y, sr = load_audio(audio_path, target_sr=None, mono=True)
    duration = float(len(y)) / sr

    result = BasicPitchResult(note_events=norm, duration_s=duration)
    _CACHE[k] = result
    return result


def clear_cache() -> None:
    _CACHE.clear()
