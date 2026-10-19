"""Optional extras shared by the beat-anchored grid engines: structural
sections and key, via librosa when it is installed. Everything degrades to
"no sections / no key" rather than failing, because the grid itself only
needs beat times."""
from __future__ import annotations

from pathlib import Path
from typing import Any


def optional_structure(
    audio_path: Path,
    max_sections: int,
    want_key: bool = True,
) -> tuple[list[float], dict[str, Any] | None]:
    """Return (section_start_times_s, detected_key_or_None)."""
    try:
        from .audio_io import load_audio
        from .engines.grid_librosa import _detect_key, _detect_sections
        import librosa  # noqa: F401  — the helpers above need it
    except ImportError:
        return [], None
    try:
        y, sr = load_audio(audio_path, target_sr=22050, mono=True)
    except Exception:  # noqa: BLE001 — audio decode problems are non-fatal here
        return [], None
    sections: list[float] = []
    key = None
    try:
        if max_sections > 0:
            sections = _detect_sections(y, sr, max_sections)
    except Exception:  # noqa: BLE001
        sections = []
    if want_key:
        try:
            key = _detect_key(y, sr)
        except Exception:  # noqa: BLE001
            key = None
    return sections, key


def audio_duration_s(audio_path: Path) -> float:
    """Duration without decoding the whole file when possible."""
    try:
        import soundfile as sf
        info = sf.info(str(audio_path))
        return float(info.frames) / float(info.samplerate)
    except Exception:  # noqa: BLE001
        pass
    try:
        import librosa
        return float(librosa.get_duration(path=str(audio_path)))
    except Exception:  # noqa: BLE001
        pass
    from .audio_io import load_audio
    y, sr = load_audio(audio_path, target_sr=None, mono=True)
    return float(len(y)) / sr
