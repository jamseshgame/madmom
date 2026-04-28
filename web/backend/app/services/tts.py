"""Text-to-speech for tutorial VO clips.

Uses Chatterbox (Resemble AI, MIT) — voice-cloning TTS that runs on CPU. The
model is ~3 GB to download on first use and ~3 GB resident while loaded.

Lazy-loaded: the model only spins up when the first /api/tts/synth call comes
in. Loading is single-threaded and guarded by a lock so concurrent requests
don't race the load.
"""

from __future__ import annotations

import asyncio
import io
import threading
from pathlib import Path
from typing import Any, Optional

_model: Any = None
_load_lock = threading.Lock()
_load_error: Optional[str] = None


def _ensure_loaded() -> Any:
    """Import + load Chatterbox once. Raises with a friendly message if the
    package isn't installed or the model fails to download."""
    global _model, _load_error
    if _model is not None:
        return _model
    if _load_error is not None:
        raise RuntimeError(_load_error)
    with _load_lock:
        if _model is not None:
            return _model
        try:
            from chatterbox.tts import ChatterboxTTS  # type: ignore
        except Exception as e:  # noqa: BLE001
            _load_error = (
                'chatterbox-tts is not installed in the backend venv. '
                'Run `pip install chatterbox-tts` and restart the service. '
                f'(import failed: {e})'
            )
            raise RuntimeError(_load_error) from e
        try:
            _model = ChatterboxTTS.from_pretrained(device='cpu')
        except Exception as e:  # noqa: BLE001
            _load_error = f'Chatterbox model failed to load: {e}'
            raise RuntimeError(_load_error) from e
    return _model


def synth_to_ogg(
    text: str,
    out_path: Path,
    reference_audio: Optional[Path] = None,
    exaggeration: float = 0.5,
    cfg_weight: float = 0.5,
) -> Path:
    """Generate speech from `text` and write an OGG file to `out_path`.

    `reference_audio` is an optional WAV/OGG/MP3 of a voice to clone. When
    omitted, Chatterbox produces its built-in default voice.

    Returns the output path. Raises RuntimeError on failure with a message
    suitable for surfacing to the user.
    """
    text = (text or '').strip()
    if not text:
        raise ValueError('text is empty')
    if len(text) > 1000:
        raise ValueError('text is over 1000 characters; split into shorter prompts')

    out_path.parent.mkdir(parents=True, exist_ok=True)

    model = _ensure_loaded()

    kwargs: dict[str, Any] = {'exaggeration': exaggeration, 'cfg_weight': cfg_weight}
    if reference_audio is not None and reference_audio.exists():
        kwargs['audio_prompt_path'] = str(reference_audio)

    # Run the actual generation. Chatterbox returns a torch tensor of shape
    # (1, samples) at the model's native sample rate.
    wav = model.generate(text=text, **kwargs)

    # Persist as OGG via soundfile / torchaudio. Chatterbox exposes its sample
    # rate via .sr; fall back to 24kHz if missing.
    sr = int(getattr(model, 'sr', 24000))
    try:
        import soundfile as sf  # type: ignore
        import numpy as np

        arr = wav
        try:
            arr = arr.detach().cpu().numpy()
        except AttributeError:
            arr = np.asarray(arr)
        if arr.ndim == 2 and arr.shape[0] in (1, 2):
            arr = arr.T  # → (samples, channels)
        # Write WAV first then transcode to OGG via ffmpeg — soundfile can do
        # OGG directly if libsndfile has vorbis support, but ffmpeg is more
        # reliable across distros.
        wav_path = out_path.with_suffix('.wav')
        sf.write(str(wav_path), arr, sr)
        import subprocess
        subprocess.run(
            [
                'ffmpeg', '-y', '-i', str(wav_path),
                '-c:a', 'libvorbis', '-q:a', '5', str(out_path),
            ],
            check=True,
            capture_output=True,
        )
        wav_path.unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f'Failed to encode TTS output: {e}') from e

    return out_path


async def synth_async(
    text: str,
    out_path: Path,
    reference_audio: Optional[Path] = None,
    exaggeration: float = 0.5,
    cfg_weight: float = 0.5,
) -> Path:
    """asyncio wrapper around synth_to_ogg — runs the heavy lifting in a thread
    so FastAPI's event loop isn't blocked."""
    return await asyncio.to_thread(
        synth_to_ogg, text, out_path, reference_audio, exaggeration, cfg_weight,
    )
