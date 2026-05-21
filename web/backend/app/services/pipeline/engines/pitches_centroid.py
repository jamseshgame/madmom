"""S3 engine: `centroid` — onset spectral centroids as fake-MIDI values.

Mirrors what the legacy chart_generator does for drum stems: spectral
centroid is the audio's "brightness" at each onset (kick = low, snare =
mid, cymbal = high). Mapping that to a fake-MIDI value lets the lane
engine's percentile binning spread drum hits across frets the same way
it spreads pitched notes for guitar.

Works for non-drum stems too — it gives a centroid-based alternative
to YIN/CREPE for any stem, but the display name flags drums as the
primary use case.

The spectral-centroid computation mirrors compute_spectral_centroids /
compute_onset_centroids in bin/JamseshChartGenerator (same algorithm,
inlined here to avoid the bin/ import path being environment-dependent).
"""
from __future__ import annotations

import datetime as dt
import math
from pathlib import Path
from typing import Any, Callable

import numpy as np

from ..registry import EngineSpec, Stage, register_engine


_PARAMS_SCHEMA = {
    'min_centroid_hz': {'type': 'number', 'min': 50, 'max': 500, 'step': 10, 'default': 100,
                        'label': 'Min expected centroid (Hz)'},
    'max_centroid_hz': {'type': 'number', 'min': 2000, 'max': 12000, 'step': 100, 'default': 8000,
                        'label': 'Max expected centroid (Hz)'},
    'window_ms': {'type': 'number', 'min': 5, 'max': 200, 'step': 5, 'default': 30,
                  'label': 'Window around onset (ms)'},
}

# Centroids below this fraction of min_centroid_hz are considered silent
# (numerical noise from a silent spectrogram) and yield dominant_midi=None.
_SILENCE_FRACTION = 0.5


def _compute_spectral_centroids(spec_array: np.ndarray, bin_frequencies: np.ndarray):
    """Compute per-frame spectral centroid (Hz) and spread.

    Mirrors compute_spectral_centroids in bin/JamseshChartGenerator.

    Parameters
    ----------
    spec_array:
        2-D float array shape (num_frames, num_bins) — the spectrogram magnitude.
    bin_frequencies:
        1-D float array of centre frequencies in Hz for each bin.

    Returns
    -------
    centroids : np.ndarray shape (num_frames,)
    spreads   : np.ndarray shape (num_frames,)
    """
    power = spec_array ** 2
    total_power = np.sum(power, axis=1, keepdims=True)
    total_power = np.maximum(total_power, 1e-10)

    centroids = np.sum(power * bin_frequencies[np.newaxis, :], axis=1) / total_power.squeeze()
    spreads = np.sqrt(
        np.sum(power * (bin_frequencies[np.newaxis, :] - centroids[:, np.newaxis]) ** 2, axis=1)
        / total_power.squeeze()
    )
    return centroids, spreads


def _compute_onset_centroids(onset_times: np.ndarray, centroids: np.ndarray, spreads: np.ndarray, fps: float):
    """Look up centroid and spread at each onset time (3-frame window average).

    Mirrors compute_onset_centroids in bin/JamseshChartGenerator.
    """
    oc = np.zeros(len(onset_times))
    os_ = np.zeros(len(onset_times))
    n = len(centroids)
    for i, t in enumerate(onset_times):
        frame = int(round(float(t) * fps))
        frame = max(0, min(frame, n - 1))
        start = max(0, frame - 1)
        end = min(n, frame + 2)
        oc[i] = np.mean(centroids[start:end])
        os_[i] = np.mean(spreads[start:end])
    return oc, os_


def _centroid_to_fake_midi(c_hz: float, min_hz: float, max_hz: float) -> int:
    """Log-scale centroid (Hz) -> MIDI value in the range [40, 90].

    Lane engine's percentile binning normalises whatever distribution it
    gets, so the absolute MIDI numbers don't matter — what matters is
    monotonicity (higher centroid -> higher fake-MIDI)."""
    if not math.isfinite(c_hz) or c_hz <= 0:
        return 40
    c = max(min_hz, min(max_hz, float(c_hz)))
    span_log = math.log2(max(max_hz / min_hz, 1.0001))  # avoid /0
    frac = math.log2(c / min_hz) / span_log
    return int(40 + max(0.0, min(1.0, frac)) * 50)


def run_centroid(
    audio_path: Path | None,
    upstream: dict,
    params: dict,
    on_progress: Callable[[str, int, str], None],
) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('centroid requires a stem audio file')

    onsets_payload = upstream.get('onsets')
    if onsets_payload is None:
        raise ValueError('S3 requires upstream onsets')

    # upstream['onsets'] may be the raw list of onset dicts (as in tests/direct
    # calls) or the full stage-output dict {'onsets': [...], 'engine': ...} (as
    # loaded from disk by the pipeline runner). Normalise to a list.
    if isinstance(onsets_payload, dict):
        onsets_list = onsets_payload['onsets']
    else:
        onsets_list = onsets_payload
    onset_times = [float(o['time_s']) for o in onsets_list]

    if not onset_times:
        return {
            'engine': 'centroid', 'params': params,
            'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
            'per_onset': [],
        }

    min_hz = float(params.get('min_centroid_hz', 100))
    max_hz = float(params.get('max_centroid_hz', 8000))
    if max_hz <= min_hz:
        max_hz = min_hz + 1.0
    # Silence threshold: centroids below this are treated as effectively silent.
    silence_threshold = min_hz * _SILENCE_FRACTION
    # window_ms is informational for the schema; the legacy helpers compute
    # centroids per frame at 100 fps so the effective window is one frame
    # (~10 ms). Keeping the param for forward compatibility.

    on_progress('analyse', 30, 'Computing spectral centroids...')

    from madmom.audio.spectrogram import Spectrogram

    spec = Spectrogram(str(audio_path), frame_size=4096, fps=100, num_channels=1, sample_rate=44100)
    spec_array = np.array(spec)
    bin_frequencies = spec.bin_frequencies
    centroids, spreads = _compute_spectral_centroids(spec_array, bin_frequencies)

    onset_arr = np.asarray(onset_times, dtype=np.float64)
    onset_centroids, onset_spreads = _compute_onset_centroids(onset_arr, centroids, spreads, 100)

    on_progress('analyse', 70, f'Mapping {len(onset_times)} onsets to fake-MIDI...')

    per_onset = []
    for i, t in enumerate(onset_times):
        c = float(onset_centroids[i]) if i < len(onset_centroids) else float('nan')
        if not math.isfinite(c) or c <= 0 or c < silence_threshold:
            per_onset.append({
                'time_s': t, 'dominant_midi': None,
                'dominant_confidence': None, 'polyphony': 1, 'all_pitches_midi': [],
            })
            continue
        midi = _centroid_to_fake_midi(c, min_hz, max_hz)
        # Spread (variance) inversely correlates with confidence: a peaky
        # centroid distribution = high confidence in the centroid value.
        spread = float(onset_spreads[i]) if i < len(onset_spreads) else 1.0
        conf = float(1.0 / (1.0 + spread))
        per_onset.append({
            'time_s': t, 'dominant_midi': midi,
            'dominant_confidence': conf, 'polyphony': 1, 'all_pitches_midi': [midi],
        })

    on_progress('done', 100, f'{len(per_onset)} per-onset entries')
    return {
        'engine': 'centroid', 'params': params,
        'generated_at': dt.datetime.utcnow().isoformat() + 'Z',
        'per_onset': per_onset,
    }


register_engine(Stage.PITCHES, EngineSpec(
    id='centroid', display_name='Spectral centroid (drum-friendly)',
    params_schema=_PARAMS_SCHEMA, runner=run_centroid,
))
