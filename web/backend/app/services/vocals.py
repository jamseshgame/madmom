"""Vocal beatmap service — pitch detection, syllabify, voicing classify,
chart injection, persistence.

See docs/superpowers/specs/2026-05-05-vocal-beatmaps-design.md.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
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


_WHISPER_FALLBACK_DUR_S = 0.6   # final-word fallback when no next-word gap exists
_WHISPER_MAX_INFERRED_S = 2.0   # cap inferred durations at 2s for unusually long gaps


def syllabify(words: list[dict], language: str = "en") -> list[dict]:
    """Split each word into syllables using Sonority Sequencing for English.

    For non-English languages, falls back to one-syllable-per-word (no v1
    syllabifier). Each input word may carry `time_s`, `duration_s` (optional),
    `text`, `phrase_start`, `phrase_end`. The output preserves phrase
    boundaries on the first/last syllable of each phrase respectively. Each
    word's time window is split across its syllables proportional to character
    count.

    When `duration_s` is missing or None on a word (whisper word-level output
    omits it), infer it from the gap to the next word's `time_s`, capped at
    2.0s and floored at 0.05s. The last word falls back to a 0.6s default.
    Without this, every syllable would carry duration_s=0, which collapses
    pitch alignment to empty windows downstream.
    """
    is_english = bool(language) and language.lower().startswith("en")
    out: list[dict] = []
    for idx, w in enumerate(words):
        text = (w.get("text") or "").strip()
        if not text:
            continue
        parts = _split_english_syllables(text) if is_english else [text]
        if not parts:
            parts = [text]
        word_start = float(w.get("time_s", 0.0))
        raw_dur = w.get("duration_s")
        if raw_dur is None or float(raw_dur) <= 0:
            # Infer from gap to next word's time_s; final word uses fallback.
            next_t: float | None = None
            for j in range(idx + 1, len(words)):
                nxt = words[j]
                if (nxt.get("text") or "").strip():
                    nxt_time = nxt.get("time_s")
                    if nxt_time is not None:
                        next_t = float(nxt_time)
                    break
            if next_t is not None and next_t > word_start:
                word_dur = min(_WHISPER_MAX_INFERRED_S, max(0.05, next_t - word_start))
            else:
                word_dur = _WHISPER_FALLBACK_DUR_S
        else:
            word_dur = float(raw_dur)
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
    import torch
    import torchaudio

    # Cap intra-op + inter-op threads to avoid 45-thread CPU thrash that made
    # CREPE inference take ~40x longer than necessary on a 4-min song.
    try:
        torch.set_num_threads(max(1, min(8, (os.cpu_count() or 2) // 2)))
        torch.set_num_interop_threads(2)
    except RuntimeError:
        # set_num_interop_threads must be called before any parallel work;
        # subsequent calls raise. Ignore — first call wins for the process.
        pass

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
    # Capture the torchcrepe package version so the UI can flag stale
    # vocalmaps the same way it does for lyrics + faster-whisper.
    try:
        from importlib.metadata import version as _pkg_version
        pitch_model_version = _pkg_version('torchcrepe')
    except Exception:
        pitch_model_version = None
    return {
        'version': 1,
        'syllabified_from': lyrics.get('source') or 'unknown',
        'pitch_model': 'torchcrepe-full',
        'pitch_model_version': pitch_model_version,
        'syllabifier': f'ssp-{language}' if is_english else 'per-word',
        'frame_hop_s': hop_s,
        'lyrics_etag': lyrics_etag,
        'fetched_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'syllables': out_sylls,
    }


def write_vocal_notes(target_dir: Path, notes: dict) -> Path:
    """Persist vocal_notes.json in target_dir."""
    path = target_dir / 'vocal_notes.json'
    path.write_text(
        json.dumps(notes, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    return path


def load_vocal_notes(target_dir: Path) -> dict | None:
    """Read vocal_notes.json from target_dir. Returns None if absent."""
    path = target_dir / 'vocal_notes.json'
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding='utf-8'))


# ---------------------------------------------------------------------------
# Versioned vocalmap history. Mirror lyrics_versions/: every successful
# /api/vocals/generate snapshots its result here so users can compare runs
# (different torchcrepe versions, edited lyric sources, hand-edited
# vocal_notes saves) and pick which one becomes the active vocal_notes.json.
import re

_VOCAL_VERSIONS_SUBDIR = 'vocal_notes_versions'
_VOCAL_VERSION_FILE_RE = re.compile(r'^(\d{8}T\d{6}Z)_torchcrepe\.json$')


def _vocal_versions_dir(target_dir: Path) -> Path:
    return target_dir / _VOCAL_VERSIONS_SUBDIR


def _utc_stamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def save_vocal_notes_version(target_dir: Path, notes: dict) -> Path | None:
    """Snapshot a freshly-generated vocal_notes.json into the versions folder.

    Filename pattern: <UTC stamp>_torchcrepe.json. lyrics.json's history
    distinguishes lrclib vs whisper in the filename; vocalmaps only have
    one source today (torchcrepe), but the suffix keeps the format
    forward-compatible with future detectors.
    """
    if not notes:
        return None
    vdir = _vocal_versions_dir(target_dir)
    vdir.mkdir(parents=True, exist_ok=True)
    path = vdir / f'{_utc_stamp()}_torchcrepe.json'
    path.write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding='utf-8')
    return path


def list_vocal_notes_versions(target_dir: Path) -> list[dict]:
    """Newest-first list. Each entry: {file, source, fetched_at, syllable_count,
    pitch_model_version, syllabified_from, active}."""
    vdir = _vocal_versions_dir(target_dir)
    if not vdir.exists():
        return []
    active = load_vocal_notes(target_dir) or {}
    active_etag = active.get('fetched_at')
    out: list[dict] = []
    for p in vdir.iterdir():
        if not p.is_file():
            continue
        m = _VOCAL_VERSION_FILE_RE.match(p.name)
        if not m:
            continue
        ts_str = m.group(1)
        try:
            data = json.loads(p.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            continue
        try:
            ts = datetime.datetime.strptime(ts_str, '%Y%m%dT%H%M%SZ').replace(
                tzinfo=datetime.timezone.utc,
            )
            fetched_iso = ts.strftime('%Y-%m-%dT%H:%M:%SZ')
        except ValueError:
            fetched_iso = ts_str
        out.append({
            'file': p.name,
            'source': 'torchcrepe',
            'fetched_at': fetched_iso,
            'syllable_count': len(data.get('syllables') or []),
            'pitch_model_version': data.get('pitch_model_version'),
            'syllabified_from': data.get('syllabified_from'),
            'active': active_etag is not None and data.get('fetched_at') == active_etag,
        })
    out.sort(key=lambda x: x['file'], reverse=True)
    return out


def load_vocal_notes_version(target_dir: Path, filename: str) -> dict | None:
    if not _VOCAL_VERSION_FILE_RE.match(filename):
        return None
    p = _vocal_versions_dir(target_dir) / filename
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding='utf-8'))


def activate_vocal_notes_version(target_dir: Path, filename: str) -> dict | None:
    data = load_vocal_notes_version(target_dir, filename)
    if data is None:
        return None
    write_vocal_notes(target_dir, data)
    return data


def _escape_chart_text(text: str) -> str:
    return text.replace('\\', '\\\\').replace('"', '\\"')


def _format_curve(curve: list[float]) -> str:
    return ','.join(f'{v:.2f}' for v in curve)


def _format_dynamics(dyn: list[float]) -> str:
    return ','.join(f'{v:.1f}' for v in dyn)


def inject_vocals_into_chart(chart_path: Path, notes: dict) -> int:
    """Rewrite the [JamseshVocals] block in `chart_path`. Idempotent: strips
    any prior [JamseshVocals] block plus any prior [Events] lyric/phrase
    events from Plan A (single source of truth). Returns syllable count."""
    from app.services.lyrics import (
        _is_lyric_event_line,
        parse_sync_track,
        seconds_to_tick,
    )

    text = chart_path.read_text(encoding='utf-8')
    resolution, segments = parse_sync_track(text)

    syllables = notes.get('syllables', [])

    new_body: list[str] = [
        f'  Version = {int(notes.get("version", 1))}',
        f'  PitchModel = "{notes.get("pitch_model", "torchcrepe-full")}"',
        f'  HopMs = {int(round(notes.get("frame_hop_s", 0.010) * 1000))}',
    ]
    for s in syllables:
        tick = seconds_to_tick(float(s['time_s']), resolution, segments)
        end_tick = seconds_to_tick(
            float(s['time_s']) + float(s.get('duration_s', 0.0)), resolution, segments,
        )
        duration_ticks = max(1, end_tick - tick)
        confidence_int = int(round(float(s.get('confidence', 0.0)) * 100))
        new_body.append(f'  {tick} = N {int(s["midi_pitch"])} {duration_ticks} {confidence_int}')
        new_body.append(f'  {tick} = E lyric {_escape_chart_text(s["text"])}')
        new_body.append(f'  {tick} = V {s.get("voicing", "sung")}')
        if s.get('dynamics_db'):
            new_body.append(f'  {tick} = D {_format_dynamics(s["dynamics_db"])}')
        if s.get('pitch_curve_st'):
            new_body.append(f'  {tick} = C {_format_curve(s["pitch_curve_st"])}')
        if s.get('phrase_start'):
            new_body.append(f'  {tick} = P start')
        if s.get('phrase_end'):
            new_body.append(f'  {tick} = P end')

    new_block_lines = ['[JamseshVocals]', '{', *new_body, '}']

    # Strip any existing [JamseshVocals] block
    lines = text.splitlines()
    out_lines: list[str] = []
    i = 0
    while i < len(lines):
        if lines[i].strip() == '[JamseshVocals]':
            j = i + 1
            depth = 0
            while j < len(lines):
                if lines[j].strip() == '{':
                    depth += 1
                elif lines[j].strip() == '}':
                    if depth <= 1:
                        j += 1
                        break
                    depth -= 1
                j += 1
            i = j
            continue
        out_lines.append(lines[i])
        i += 1

    # Strip any [Events] lyric/phrase events authored by Plan A
    cleaned: list[str] = []
    in_events = False
    for line in out_lines:
        stripped = line.strip()
        if stripped == '[Events]':
            in_events = True
            cleaned.append(line)
            continue
        if in_events:
            if stripped == '}':
                in_events = False
                cleaned.append(line)
                continue
            if _is_lyric_event_line(line):
                continue
        cleaned.append(line)

    cleaned.extend(new_block_lines)
    chart_path.write_text('\n'.join(cleaned) + '\n', encoding='utf-8')

    return len(syllables)
