"""Vocal beatmap service — pitch detection, syllabify, voicing classify,
chart injection, persistence.

See docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import math
import statistics
from pathlib import Path

import numpy as np
from syllabipy.sonoripy import SonoriPy


_SUNG_CONF_MIN = 0.7
_SUNG_PITCH_STD_MAX = 1.5            # semitones
_WHISPER_DB_MAX = -40.0              # median dB
_WHISPER_CONF_MAX = 0.4


def voicing_classify(
    curve: list[float],
    confidence: float,
    dynamics_db: list[float],
) -> str:
    """Classify a single syllable as sung / spoken / whispered.

    `curve` is a per-frame list of float MIDI semitones (NaN frames already
    removed by caller); `confidence` is the syllable's median CREPE confidence
    in [0, 1]; `dynamics_db` is the syllable's per-frame RMS in dB.
    """
    median_db = statistics.median(dynamics_db) if dynamics_db else 0.0
    if confidence <= _WHISPER_CONF_MAX and median_db <= _WHISPER_DB_MAX:
        return "whispered"
    if confidence >= _SUNG_CONF_MIN and len(curve) >= 2:
        pitch_std = statistics.pstdev(curve)
        if pitch_std <= _SUNG_PITCH_STD_MAX:
            return "sung"
    return "spoken"


def _split_english_syllables(word: str) -> list[str]:
    """Split an English word into orthographic syllables via Sonority
    Sequencing Principle. Falls back to the whole word if SonoriPy returns
    nothing (e.g. all-caps input — SonoriPy's sonority table is lowercase-only,
    so we retry lowercased and re-apply the original casing position-by-position)."""
    parts = SonoriPy(word) or []
    if parts:
        return parts
    lowered = word.lower()
    if lowered != word:
        parts = SonoriPy(lowered) or []
        if parts:
            out: list[str] = []
            idx = 0
            for p in parts:
                out.append(word[idx:idx + len(p)])
                idx += len(p)
            return out
    return [word] if word else []


def syllabify(words: list[dict], language: str = "en") -> list[dict]:
    """Split each word into syllables using Sonority Sequencing for English.

    For non-English languages, falls back to one-syllable-per-word (no v1
    syllabifier). Each input word may carry `time_s`, `duration_s` (optional),
    `text`, `phrase_start`, `phrase_end`. The output preserves phrase
    boundaries on the first/last syllable of each phrase respectively. Each
    word's time window is split across its syllables proportional to character
    count.
    """
    is_english = bool(language) and language.lower().startswith("en")
    out: list[dict] = []
    for w in words:
        text = (w.get("text") or "").strip()
        if not text:
            continue
        parts = _split_english_syllables(text) if is_english else [text]
        if not parts:
            parts = [text]
        word_start = float(w.get("time_s", 0.0))
        word_dur = float(w.get("duration_s", 0.0) or 0.0)
        total_chars = sum(len(p) for p in parts) or 1
        cumulative = 0
        for i, syl in enumerate(parts):
            ratio = cumulative / total_chars
            t = word_start + ratio * word_dur
            cumulative += len(syl)
            next_ratio = cumulative / total_chars
            d = (next_ratio - ratio) * word_dur
            entry: dict = {
                "time_s": round(t, 3),
                "duration_s": round(d, 3),
                "text": syl,
            }
            if i == 0 and w.get("phrase_start"):
                entry["phrase_start"] = True
            if i == len(parts) - 1 and w.get("phrase_end"):
                entry["phrase_end"] = True
            out.append(entry)
    return out


_CREPE_LOADED = False


def _load_crepe_model():
    """Lazy-load the CREPE 'full' model. Returns the torchcrepe module so
    callers can use its predict() function. Idempotent."""
    global _CREPE_LOADED
    import torchcrepe
    if not _CREPE_LOADED:
        torchcrepe.load.model(device='cpu', capacity='full')
        _CREPE_LOADED = True
    return torchcrepe


def detect_pitches(vocals_path: Path) -> tuple[list[float], list[float]]:
    """Detect per-frame pitch (Hz) and confidence on a vocals stem.

    Returns (f0_hz, confidence). Frames where the model is unsure
    (periodicity < 0.21) have f0_hz set to NaN. 10 ms hop. Loads the model
    on first call.
    """
    import torchaudio

    audio, sr = torchaudio.load(str(vocals_path))
    if audio.shape[0] > 1:
        audio = audio.mean(dim=0, keepdim=True)
    target_sr = 16000
    if sr != target_sr:
        audio = torchaudio.functional.resample(audio, sr, target_sr)
        sr = target_sr

    hop_samples = round(sr * 0.010)
    torchcrepe = _load_crepe_model()

    pitch, periodicity = torchcrepe.predict(
        audio,
        sr,
        hop_length=hop_samples,
        model='full',
        batch_size=128,
        device='cpu',
        decoder=torchcrepe.decode.viterbi,
        return_periodicity=True,
    )

    threshold = 0.21
    f0 = pitch.squeeze(0).numpy().astype(float)
    conf = periodicity.squeeze(0).numpy().astype(float)
    f0_masked = np.where(conf < threshold, np.nan, f0)
    return f0_masked.tolist(), conf.tolist()


def _hz_to_midi(hz: float) -> float:
    if not hz or math.isnan(hz) or hz <= 0:
        return float("nan")
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def _slice_frames(
    f0: list[float],
    conf: list[float],
    start_s: float,
    duration_s: float,
    hop_s: float,
) -> tuple[list[float], list[float]]:
    """Slice the f0 + confidence frame arrays to [start_s, start_s + duration_s].
    Returns (curve_midi_floats_voiced_only, confidences_for_those_frames)."""
    if duration_s <= 0:
        return [], []
    start_idx = max(0, int(round(start_s / hop_s)))
    end_idx = min(len(f0), int(round((start_s + duration_s) / hop_s)))
    curve_midi: list[float] = []
    conf_voiced: list[float] = []
    for i in range(start_idx, end_idx):
        if math.isnan(f0[i]):
            continue
        curve_midi.append(_hz_to_midi(f0[i]))
        conf_voiced.append(conf[i])
    return curve_midi, conf_voiced


def _downsample(values: list[float], target: int) -> list[float]:
    """Reduce a list to `target` evenly-spaced samples."""
    if len(values) <= target:
        return values[:]
    out = []
    for i in range(target):
        idx = (i * len(values)) // target
        out.append(values[idx])
    return out


def build_vocal_notes(
    vocals_path: Path,
    lyrics: dict,
    progress_callback=None,
) -> dict:
    """Run pitch detection on the vocals stem, syllabify the lyrics, and
    align pitch frames to syllable windows. Returns the normalized
    `vocal_notes.json` shape."""
    if progress_callback:
        progress_callback('crepe', 70, 'Detecting pitch...')
    f0, conf = detect_pitches(vocals_path)
    hop_s = 0.010

    if progress_callback:
        progress_callback('syllabify', 60, 'Splitting into syllables...')
    language = lyrics.get('language') or 'en'
    sylls = syllabify(lyrics.get('words', []), language=language)

    if progress_callback:
        progress_callback('align', 92, 'Aligning pitch to syllables...')

    out_sylls: list[dict] = []
    for s in sylls:
        curve_midi, conf_voiced = _slice_frames(
            f0, conf, s['time_s'], s['duration_s'], hop_s,
        )
        if curve_midi:
            median_midi = sorted(curve_midi)[len(curve_midi) // 2]
            midi_pitch = int(round(median_midi))
            median_conf = sorted(conf_voiced)[len(conf_voiced) // 2]
        else:
            # No voiced frames in this syllable — borrow nearest neighbor's pitch
            midi_pitch = out_sylls[-1]['midi_pitch'] if out_sylls else 60
            median_conf = 0.0
            curve_midi = []

        # Synthetic dB envelope from confidence until RMS is wired through.
        dyn_proxy = [-30.0 + 30.0 * c for c in (conf_voiced or [median_conf])]

        voicing = voicing_classify(curve_midi, median_conf, dyn_proxy)

        entry: dict = {
            'time_s': s['time_s'],
            'duration_s': s['duration_s'],
            'text': s['text'],
            'midi_pitch': midi_pitch,
            'confidence': round(median_conf, 3),
            'voicing': voicing,
            'pitch_curve_st': [round(v, 2) for v in _downsample(curve_midi, 5)] if curve_midi else [],
            'dynamics_db': [round(v, 1) for v in _downsample(dyn_proxy, 5)],
        }
        if s.get('phrase_start'):
            entry['phrase_start'] = True
        if s.get('phrase_end'):
            entry['phrase_end'] = True
        out_sylls.append(entry)

    lyrics_etag = hashlib.sha1(
        json.dumps(lyrics, sort_keys=True, ensure_ascii=False).encode('utf-8')
    ).hexdigest()

    if progress_callback:
        progress_callback('write', 96, 'Building vocal notes...')

    is_english = bool(language) and language.lower().startswith('en')
    return {
        'version': 1,
        'syllabified_from': lyrics.get('source') or 'unknown',
        'pitch_model': 'torchcrepe-full',
        'syllabifier': f'ssp-{language}' if is_english else 'per-word',
        'frame_hop_s': hop_s,
        'lyrics_etag': lyrics_etag,
        'fetched_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'syllables': out_sylls,
    }
