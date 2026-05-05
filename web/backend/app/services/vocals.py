"""Vocal beatmap service — pitch detection, syllabify, voicing classify,
chart injection, persistence.

See docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md.
"""
from __future__ import annotations

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
