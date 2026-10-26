"""Optional extras shared by the beat-anchored grid engines: structural
sections and key, via librosa when it is installed. Everything degrades to
"no sections / no key" rather than failing, because the grid itself only
needs beat times."""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence

if TYPE_CHECKING:
    import numpy as np


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
    """Duration without decoding the whole file when possible.

    ffprobe first: it reads the container header and copes with files
    libsndfile rejects (see audio_io). soundfile second, full decode last."""
    import shutil
    import subprocess
    ffprobe = shutil.which('ffprobe')
    if ffprobe:
        try:
            out = subprocess.run(
                [ffprobe, '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                 'stream=duration:format=duration', '-of', 'default=nw=1:nk=1', str(audio_path)],
                capture_output=True, text=True, timeout=30,
            ).stdout.split()
            vals = [float(v) for v in out if v not in ('N/A', '')]
            if vals and vals[0] > 0:
                return float(vals[0])
        except Exception:  # noqa: BLE001
            pass
    try:
        import soundfile as sf
        info = sf.info(str(audio_path))
        return float(info.frames) / float(info.samplerate)
    except Exception:  # noqa: BLE001
        pass
    from .audio_io import load_audio
    y, sr = load_audio(audio_path, target_sr=None, mono=True)
    return float(len(y)) / sr


def transient_offset_s(
    y: 'np.ndarray',
    sr: int,
    beat_times: 'Sequence[float]',
    search_ms: float = 45.0,
    min_beats: int = 32,
) -> tuple[float, int]:
    """Median offset (seconds) from each beat to the nearest strong onset
    transient in the audio, over beats that have a clear transient nearby.

    Beat trackers report the perceptual beat, which on real recordings sits
    a consistent few tens of ms *before* the drum transient — measured at
    −26…−30 ms on five Harmonix references, whose notes sit within ±5 ms of
    the transient. A chart quantized to an early grid is early everywhere,
    so the grid engines shift the whole beat list by this value (a single
    global shift keeps the tempo map smooth).

    Returns (offset_s, n_beats_used); offset is 0 when too few beats have a
    usable transient. Positive = beats should move later.
    """
    import numpy as np
    from scipy.signal import stft

    hop = 64
    _f, _t, Z = stft(y, fs=sr, nperseg=512, noverlap=512 - hop, boundary='zeros', padded=True)
    L = np.log1p(50 * np.abs(Z)).sum(0)
    flux = np.maximum(np.diff(L, prepend=L[:1]), 0)
    hop_s = hop / sr
    search = int(round(search_ms / 1000.0 / hop_s))
    strong = float(np.percentile(flux[flux > 0], 75)) if np.any(flux > 0) else 0.0
    offsets = []
    for bt in beat_times:
        c = int(round(float(bt) / hop_s))
        a, b = c - search, c + search + 1
        if a < 0 or b > len(flux):
            continue
        seg = flux[a:b]
        k = int(np.argmax(seg))
        if seg[k] < strong:
            continue
        # Parabolic refinement of the peak position.
        d = 0.0
        if 0 < k < len(seg) - 1:
            den = seg[k - 1] - 2 * seg[k] + seg[k + 1]
            if den != 0:
                d = 0.5 * (seg[k - 1] - seg[k + 1]) / den
        offsets.append(((a + k + d) * hop_s) - float(bt))
    if len(offsets) < min_beats:
        return 0.0, len(offsets)
    return float(np.median(offsets)), len(offsets)


def find_drum_stem(mix_path: Path) -> Path | None:
    """The track's separated drum stem, if it sits beside the full mix
    (flat Tracks layout `stems/drums.ogg` or V2 `stems/drums/*.ogg`)."""
    stems_dir = mix_path.parent
    for ext in ('.ogg', '.wav', '.flac', '.mp3'):
        p = stems_dir / f'drums{ext}'
        if p.exists():
            return p
    sub = stems_dir / 'drums'
    if sub.is_dir():
        for p in sorted(sub.iterdir()):
            if p.suffix.lower() in ('.ogg', '.wav', '.flac', '.mp3'):
                return p
    return None


def calibrate_beats(
    beat_times: 'Sequence[float]',
    mix_path: Path,
    params: dict[str, Any],
    on_progress=None,
) -> tuple[list[float], dict[str, Any]]:
    """Apply the transient calibration (plus any manual `beat_offset_ms`)
    to a beat list. Uses the drum stem when one sits beside the mix
    (≈2 ms accurate on references), else the mix (≈±10 ms).

    Params: `snap_to_transients` (bool, default True), `beat_offset_ms`
    (manual extra shift, default 0), `max_snap_ms` (cap, default 60).
    Returns (shifted_beats, info)."""
    import numpy as np

    manual_s = float(params.get('beat_offset_ms', 0) or 0) / 1000.0
    info: dict[str, Any] = {'transient_offset_ms': 0.0, 'calibration_source': None, 'beats_used': 0,
                            'manual_offset_ms': manual_s * 1000.0}
    shift = 0.0
    if bool(params.get('snap_to_transients', True)):
        src = find_drum_stem(mix_path) or mix_path
        try:
            from .audio_io import load_audio
            y, sr = load_audio(src, target_sr=22050, mono=True)
            off, n = transient_offset_s(y, sr, beat_times)
            cap = float(params.get('max_snap_ms', 60)) / 1000.0
            off = float(np.clip(off, -cap, cap))
            info.update({'transient_offset_ms': off * 1000.0, 'calibration_source': src.name, 'beats_used': n})
            shift = off
            if on_progress:
                on_progress('calibrate', 65, f'Grid shifted {off * 1000:+.0f} ms to drum transients ({src.name}, {n} beats)')
        except Exception as e:  # noqa: BLE001 — calibration is best-effort
            if on_progress:
                on_progress('calibrate', 65, f'Transient calibration skipped: {e}')
    total = shift + manual_s
    return [max(0.0, float(t) + total) for t in beat_times], info
