"""S2 engine: `drum-adtof` — drum hits by a pretrained transcription model.

Why: the band-split detector hears *that* a hit happened (onset F1 0.85–0.90
on two Harmonix references) but cannot say *what* was hit when drums
coincide — and on a real kit most hits coincide. Measured on both
references, a classifier over onset-frame band features can't separate the
pads even within one song (~50 % vs ~40 % majority baseline), because the
features describe the mixture. Fixing that needs a model that decomposes
mixtures, not more thresholds.

ADTOF (Zehren et al., ISMIR 2021) is a CRNN trained on ~359 h of rhythm-game
charts — the same charting conventions as the references the eval harness
scores against — with the five-class vocabulary this column already uses:
kick, snare, tom, hi-hat, cymbal/ride. `adtof-pytorch` ships the weights
and needs only torch + librosa + pretty_midi, all already installed here.

    pip install git+https://github.com/xavriley/ADTOF-pytorch

The engine runs the model on the drum stem, parses the MIDI it writes with
the in-repo SMF parser (no pretty_midi import needed on our side), and
emits the same payload shape as `drum-bandsplit` (`onsets` +
`drum_classes` + `onset_classes`), so drum-class → drum-gm → serializer →
drum-class-removal work unchanged. Model content is CC BY-NC-SA 4.0, like
madmom's own models.
"""
from __future__ import annotations

import datetime as dt
import tempfile
from pathlib import Path
from typing import Any, Callable

from ..drum_detect import CLASS_FOR_GM, DRUM_CLASSES, DrumHit, merge_hits
from ..registry import EngineSpec, Stage, register_engine

try:  # registration must not fail when the model package is absent
    import adtof_pytorch  # noqa: F401
    ADTOF_AVAILABLE = True
except ImportError:
    ADTOF_AVAILABLE = False

# ADTOF's output vocabulary (GM percussion numbers): BD 35, SD 38, TT 47,
# HH 42, CY+RD 49. Any other GM drum number it may emit is mapped by
# CLASS_FOR_GM as well.
_PARAMS_SCHEMA = {
    'threshold_kick': {'type': 'number', 'min': 0.05, 'max': 0.9, 'step': 0.01, 'default': 0.22,
                       'label': 'Peak threshold: kick'},
    'threshold_snare': {'type': 'number', 'min': 0.05, 'max': 0.9, 'step': 0.01, 'default': 0.24,
                        'label': 'Peak threshold: snare'},
    'threshold_tom': {'type': 'number', 'min': 0.05, 'max': 0.9, 'step': 0.01, 'default': 0.32,
                      'label': 'Peak threshold: tom'},
    'threshold_hihat': {'type': 'number', 'min': 0.05, 'max': 0.9, 'step': 0.01, 'default': 0.22,
                        'label': 'Peak threshold: hi-hat'},
    'threshold_cymbal': {'type': 'number', 'min': 0.05, 'max': 0.9, 'step': 0.01, 'default': 0.30,
                         'label': 'Peak threshold: cymbal/ride'},
    'merge_ms': {'type': 'number', 'min': 5, 'max': 40, 'step': 1, 'default': 15,
                 'label': 'Merge hits closer than (ms) into one onset'},
    'device': {'type': 'enum', 'options': ['auto', 'cpu', 'cuda', 'mps'], 'default': 'auto',
               'label': 'Inference device'},
}
# Order of the model's five outputs = order of the --thresholds argument.
_THRESHOLD_ORDER = ('threshold_kick', 'threshold_snare', 'threshold_tom', 'threshold_hihat', 'threshold_cymbal')


def _device(params: dict[str, Any]) -> str:
    dev = str(params.get('device', 'auto'))
    if dev != 'auto':
        return dev
    try:
        import torch
        if torch.cuda.is_available():
            return 'cuda'
        if getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_available():
            return 'mps'
    except ImportError:
        pass
    return 'cpu'


def transcribe_with_adtof(audio_path: Path, params: dict[str, Any]) -> list[tuple[float, int, float]]:
    """Run ADTOF on `audio_path`. Returns [(time_s, gm_pitch, velocity_0_1)].

    Split out so tests can monkeypatch it; the real call shells through the
    package's `transcribe_to_midi` and reads the MIDI back."""
    from adtof_pytorch import transcribe_to_midi

    from ..reference_charts import parse_midi

    thresholds = [float(params.get(k, _PARAMS_SCHEMA[k]['default'])) for k in _THRESHOLD_ORDER]
    with tempfile.TemporaryDirectory(prefix='adtof_') as td:
        out = Path(td) / 'drums.mid'
        kwargs: dict[str, Any] = {'thresholds': thresholds, 'device': _device(params)}
        try:
            transcribe_to_midi(str(audio_path), str(out), **kwargs)
        except TypeError:
            # Older/newer signatures: fall back to the minimal call.
            transcribe_to_midi(str(audio_path), str(out))
        div, tracks = parse_midi(out)
        tempo_us = next((t for tr in tracks for _tick, t in tr['tempos']), 500_000)
        sec_per_tick = tempo_us / 1e6 / div
        hits = []
        for tr in tracks:
            for start, _end, pitch in tr['notes']:
                hits.append((start * sec_per_tick, int(pitch), 1.0))
    hits.sort()
    return hits


def run_drum_adtof(audio_path: Path | None, upstream: dict, params: dict[str, Any],
                   on_progress: Callable[[str, int, str], None]) -> dict[str, Any]:
    if audio_path is None:
        raise ValueError('drum-adtof requires a drum stem audio file')
    if not ADTOF_AVAILABLE:
        raise RuntimeError('adtof-pytorch is not installed: '
                           'pip install git+https://github.com/xavriley/ADTOF-pytorch')
    on_progress('model', 10, f'Running ADTOF drum transcription on {_device(params)}…')
    raw = transcribe_with_adtof(audio_path, params)
    hits: dict[str, list[DrumHit]] = {c: [] for c in DRUM_CLASSES}
    unknown = 0
    for t, pitch, vel in raw:
        cls = CLASS_FOR_GM.get(pitch)
        if cls is None:
            unknown += 1
            continue
        hits[cls].append(DrumHit(float(t), float(min(1.0, max(0.0, vel)))))
    for c in hits:
        hits[c].sort(key=lambda h: h.time_s)
    merged = merge_hits(hits, merge_ms=float(params.get('merge_ms', 15)))
    onsets = [{'time_s': m['time_s'], 'confidence': min(1.0, m['confidence']), 'source_note_id': None}
              for m in merged]
    counts = {c: len(h) for c, h in hits.items()}
    on_progress('done', 100, ', '.join(f'{c}={n}' for c, n in counts.items())
                + (f' ({unknown} unmapped pitches)' if unknown else ''))
    return {
        'engine': 'drum-adtof', 'params': params,
        'generated_at': dt.datetime.now(dt.UTC).isoformat().replace('+00:00', 'Z'),
        'onsets': onsets,
        'drum_classes': {c: [h.as_dict() for h in hs] for c, hs in hits.items()},
        'onset_classes': [m['classes'] for m in merged],
    }


register_engine(Stage.ONSETS, EngineSpec(
    id='drum-adtof',
    display_name='Drum hits: ADTOF transcription model (drums)' + ('' if ADTOF_AVAILABLE else ' — not installed'),
    params_schema=_PARAMS_SCHEMA,
    runner=run_drum_adtof,
))
