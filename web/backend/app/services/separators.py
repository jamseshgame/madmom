"""Multi-engine stem separation.

Demucs alone tops out well below the current state of the art on vocals, so
this module widens the backend to three interchangeable engines:

``demucs``
    The original path — Hybrid Transformer Demucs (``htdemucs`` family) run as
    a subprocess. Still the only engine that natively yields six instrument
    stems, and the fastest of the three.

``audio-separator``
    `python-audio-separator <https://github.com/nomadkaraoke/python-audio-separator>`_,
    which wraps four separate open-source model families behind one CLI:
    **MDXC/Roformer** (BS-Roformer and Mel-Band Roformer — the SDX'23-winning
    architecture and the current SOTA for vocals), **MDX-Net**, **VR Arch**
    (the UVR5 models) and its own Demucs bridge. Its catalog is fetched at
    runtime rather than hardcoded here, so newly published checkpoints show up
    without a code change. Most of its best models are two-stem
    (vocals/instrumental).

``hybrid`` *(default)*
    Best of both, and the reason this module exists. A Roformer pass extracts
    vocals at Roformer quality, then Demucs splits the **Roformer
    instrumental** — not the original mix — into the remaining instruments, so
    no instrument stem carries vocal bleed. Costs two full inference passes.

Every engine publishes a declarative parameter schema (:data:`ENGINES`) that
the frontend renders generically. Adding a knob here surfaces it in the UI
automatically; there is no per-engine form to keep in sync.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..config import settings
from .stems import (
    DEFAULT_MODEL,
    MODEL_STEMS,
    _PROGRESS_RE,
    _stream_demucs,
    _write_peaks_file,
    collect_demucs_outputs,
    finalize_game_ready,
    separate_stems,
    separator_child_env,
)


# ─────────────────────────────────────────────────────────────────────────────
# Parameter schema
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Param:
    """One user-facing knob.

    ``type`` drives the widget the frontend renders: ``int``/``float`` become
    sliders (or number inputs when unbounded), ``bool`` a toggle, ``enum`` a
    select, ``str`` a text field. ``group`` lets the UI band related knobs
    together (one card per model architecture), and ``advanced`` hides the
    long tail behind a disclosure without removing it.
    """

    key: str
    label: str
    type: str
    default: Any
    help: str = ''
    group: str = 'General'
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    options: list[str] = field(default_factory=list)
    advanced: bool = False
    # Only meaningful for a subset of models; the UI greys these out rather
    # than hiding them so "all settings are shown" stays literally true.
    applies_to: str = ''


@dataclass
class Engine:
    key: str
    label: str
    description: str
    quality: str
    speed: str
    params: list[Param]


# ── shared audio-separator parameter blocks ─────────────────────────────────
# Defaults mirror python-audio-separator's own defaults except where a higher
# quality setting exists, since this build defaults to max quality.

def _common_params() -> list[Param]:
    return [
        Param('output_format', 'Intermediate format', 'enum', 'WAV', group='Output',
              options=['WAV', 'FLAC', 'MP3', 'M4A'],
              help='Format the separator writes before Jamsesh transcodes to OGG. '
                   'Lossless (WAV/FLAC) avoids a generation-loss stage.'),
        Param('output_bitrate', 'Output bitrate', 'str', '', group='Output', advanced=True,
              help='Only used for lossy intermediate formats, e.g. "320k". Blank = codec default.'),
        Param('sample_rate', 'Sample rate', 'int', 44100, group='Output',
              minimum=8000, maximum=192000, step=100,
              help='Output sample rate in Hz. 44100 matches CD audio and the game runtime.'),
        Param('normalization', 'Normalization threshold', 'float', 0.9, group='Output',
              minimum=0.0, maximum=1.0, step=0.01,
              help='Peak the output is normalized to. Lower values leave more headroom '
                   'and reduce clipping on loud masters.'),
        Param('amplification', 'Amplification threshold', 'float', 0.0, group='Output',
              minimum=0.0, maximum=1.0, step=0.01, advanced=True,
              help='Quiet stems below this peak get amplified up to it. 0 disables.'),
        Param('invert_spect', 'Invert secondary stem via spectrogram', 'bool', False,
              group='Output', advanced=True,
              help='Derive the secondary stem by spectrogram subtraction instead of waveform '
                   'subtraction. Occasionally cleaner, occasionally phasey.'),
        Param('use_soundfile', 'Write with soundfile', 'bool', False, group='Output', advanced=True,
              help='Use the soundfile writer instead of the default. Workaround for codec issues.'),
        Param('use_autocast', 'Mixed-precision inference', 'bool', False, group='Performance',
              help='PyTorch autocast (fp16). Roughly 2x faster on CUDA GPUs at a small '
                   'quality cost. Off by default because this build targets max quality.'),
        Param('chunk_duration', 'Chunk duration (s)', 'float', 0, group='Performance', advanced=True,
              minimum=0, maximum=600, step=10,
              help='Split long inputs into chunks of this many seconds to cap peak RAM. '
                   '0 = process the whole file at once (best quality, no seam artifacts).'),
    ]


def _mdxc_params(prefix_note: str = '') -> list[Param]:
    note = f' {prefix_note}' if prefix_note else ''
    return [
        Param('mdxc_segment_size', 'MDXC segment size', 'int', 256, group='Roformer / MDXC',
              minimum=32, maximum=2048, step=32, applies_to='MDXC and Roformer models',
              help=f'Inference window length.{note} Larger windows give the transformer more '
                   'context but use more memory.'),
        Param('mdxc_override_model_segment_size', 'Override model segment size', 'bool', False,
              group='Roformer / MDXC', advanced=True, applies_to='MDXC and Roformer models',
              help='Force the segment size above instead of the value baked into the '
                   "model's config. Leave off unless you know the model tolerates it."),
        Param('mdxc_overlap', 'MDXC overlap', 'int', 8, group='Roformer / MDXC',
              minimum=2, maximum=32, step=1, applies_to='MDXC and Roformer models',
              help='Number of overlapping inference windows averaged together. Higher = '
                   'smoother seams and better quality, linearly slower.'),
        Param('mdxc_batch_size', 'MDXC batch size', 'int', 1, group='Roformer / MDXC',
              minimum=1, maximum=32, step=1, applies_to='MDXC and Roformer models',
              help='Windows processed per forward pass. Raise only if you have GPU memory '
                   'to spare; it does not change output quality.'),
        Param('mdxc_pitch_shift', 'MDXC pitch shift (semitones)', 'int', 0,
              group='Roformer / MDXC', advanced=True, minimum=-12, maximum=12, step=1,
              applies_to='MDXC and Roformer models',
              help='Shift the input before separation and shift back after. Can help models '
                   'that struggle with unusually high or low vocals.'),
    ]


def _mdx_params() -> list[Param]:
    return [
        Param('mdx_segment_size', 'MDX segment size', 'int', 256, group='MDX-Net',
              minimum=32, maximum=2048, step=32, applies_to='MDX-Net models',
              help='Inference window length for MDX-Net checkpoints.'),
        Param('mdx_overlap', 'MDX overlap', 'float', 0.25, group='MDX-Net',
              minimum=0.0, maximum=0.99, step=0.05, applies_to='MDX-Net models',
              help='Fractional overlap between windows. Higher = fewer seam artifacts, slower.'),
        Param('mdx_batch_size', 'MDX batch size', 'int', 1, group='MDX-Net',
              minimum=1, maximum=32, step=1, applies_to='MDX-Net models',
              help='Windows per forward pass. Throughput only — no quality effect.'),
        Param('mdx_hop_length', 'MDX hop length', 'int', 1024, group='MDX-Net',
              minimum=64, maximum=8192, step=64, advanced=True, applies_to='MDX-Net models',
              help='STFT hop size. Must match what the checkpoint was trained with; '
                   'changing it usually degrades output.'),
        Param('mdx_enable_denoise', 'MDX denoise', 'bool', True, group='MDX-Net',
              applies_to='MDX-Net models',
              help='Run inference twice (normal + phase-inverted) and average, cancelling '
                   'model noise. Doubles runtime, measurably cleaner — on by default here.'),
    ]


def _vr_params() -> list[Param]:
    return [
        Param('vr_batch_size', 'VR batch size', 'int', 1, group='VR Arch (UVR5)',
              minimum=1, maximum=32, step=1, applies_to='VR Arch models',
              help='Windows per forward pass. Throughput only.'),
        Param('vr_window_size', 'VR window size', 'enum', '320', group='VR Arch (UVR5)',
              options=['1024', '512', '320'], applies_to='VR Arch models',
              help='Spectrogram window. Smaller is slower but more detailed — 320 is the '
                   'quality setting, 1024 the fast one.'),
        Param('vr_aggression', 'VR aggression', 'int', 5, group='VR Arch (UVR5)',
              minimum=-100, maximum=100, step=1, applies_to='VR Arch models',
              help='How hard the primary stem is pulled out. Higher removes more bleed but '
                   'starts eating the stem itself.'),
        Param('vr_enable_tta', 'VR test-time augmentation', 'bool', True, group='VR Arch (UVR5)',
              applies_to='VR Arch models',
              help='Average several augmented passes. Slower, consistently better — on by '
                   'default here.'),
        Param('vr_high_end_process', 'VR high-end process', 'bool', False,
              group='VR Arch (UVR5)', advanced=True, applies_to='VR Arch models',
              help='Mirror the missing high band back in. Restores air on models with a low '
                   'training bandwidth, but is synthetic content.'),
        Param('vr_enable_post_process', 'VR post-process', 'bool', False,
              group='VR Arch (UVR5)', advanced=True, applies_to='VR Arch models',
              help='Extra artifact-removal pass. Helps on noisy separations, can dull clean ones.'),
        Param('vr_post_process_threshold', 'VR post-process threshold', 'float', 0.2,
              group='VR Arch (UVR5)', advanced=True, minimum=0.1, maximum=0.3, step=0.01,
              applies_to='VR Arch models (post-process on)',
              help='Strength of the post-process pass.'),
    ]


def _demucs_params(group: str = 'Demucs', *, include_model: bool = True) -> list[Param]:
    params: list[Param] = []
    if include_model:
        params.append(
            Param('model', 'Demucs model', 'enum', 'htdemucs_6s', group=group,
                  options=list(MODEL_STEMS.keys()),
                  help='htdemucs_6s adds guitar and piano stems; htdemucs_ft is a fine-tuned '
                       '4-stem model that scores higher on the stems it does produce.'),
        )
    params += [
        Param('shifts', 'Shifts (random-shift averaging)', 'int', 10, group=group,
              minimum=1, maximum=20, step=1,
              help='Number of randomly time-shifted passes averaged together. Each shift is '
                   'a full pass over the audio — 10 is ~10x the runtime of 1. Quality gains '
                   'flatten out around 2-4 for most music.'),
        Param('overlap', 'Overlap', 'float', 0.75, group=group,
              minimum=0.0, maximum=0.99, step=0.05,
              help='Fractional overlap between inference windows. Higher hides window seams '
                   'at a roughly proportional cost in time.'),
        Param('segment', 'Segment length (s)', 'int', 0, group=group, advanced=True,
              minimum=0, maximum=100, step=1,
              help='Chunk length fed to the model. 0 = model default. Lower it if Demucs '
                   'runs out of memory on long tracks.'),
        Param('clip_mode', 'Clip mode', 'enum', 'rescale', group=group,
              options=['rescale', 'clamp', 'none'],
              help='What to do when a stem exceeds full scale. Rescale lowers the whole stem '
                   '(no distortion); clamp hard-limits the peaks.'),
        Param('jobs', 'Parallel jobs', 'int', 0, group=group, advanced=True,
              minimum=0, maximum=16, step=1,
              help='Worker processes. 0 = Demucs default. Each job holds its own copy of the '
                   'model in RAM.'),
        Param('mp3_bitrate', 'MP3 bitrate', 'int', 320, group=group, advanced=True,
              minimum=64, maximum=320, step=32, applies_to='MP3 output only',
              help='Bitrate when the intermediate format is MP3.'),
    ]
    return params


# The Roformer checkpoint the hybrid engine leads with. This is
# python-audio-separator's own default: the SDX'23-winning BS-Roformer, which
# is the most widely validated vocal model in the catalog. Any other catalog
# entry can be typed in instead — the field is a free-text model filename so
# newly released checkpoints work without a code change.
DEFAULT_ROFORMER_MODEL = 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'

DEFAULT_ENGINE = 'hybrid'


ENGINES: dict[str, Engine] = {
    'hybrid': Engine(
        key='hybrid',
        label='Hybrid — Roformer + Demucs',
        description=(
            'Maximum quality. A Roformer model lifts the vocal, then Demucs splits the '
            'Roformer instrumental (not the original mix) into drums, bass, guitar, piano '
            'and other — so no instrument stem carries vocal bleed. Two full inference '
            'passes, so roughly the sum of both engines\' runtimes.'
        ),
        quality='Highest',
        speed='Slowest',
        params=[
            Param('vocal_model', 'Roformer vocal model', 'model', DEFAULT_ROFORMER_MODEL,
                  group='Vocal pass',
                  help='Any two-stem vocal model from the audio-separator catalog. '
                       'BS-Roformer and Mel-Band Roformer checkpoints score highest.'),
            Param('instruments_from', 'Split instruments from', 'enum', 'instrumental',
                  group='Instrument pass',
                  options=['instrumental', 'original'],
                  help='"instrumental" feeds Demucs the vocal-free mix from the Roformer pass '
                       '— cleaner instrument stems. "original" runs Demucs on the untouched '
                       'master, which preserves anything the Roformer pass mistakenly removed.'),
            *_mdxc_params('For the vocal pass.'),
            *_demucs_params('Instrument pass (Demucs)'),
            *_common_params(),
        ],
    ),
    'audio-separator': Engine(
        key='audio-separator',
        label='audio-separator — Roformer / MDX-Net / VR',
        description=(
            'Single-model separation across four open-source architectures: MDXC (BS-Roformer '
            'and Mel-Band Roformer), MDX-Net, VR Arch (the UVR5 models) and Demucs. Pick any '
            'checkpoint from the live catalog. Most top-scoring models here are two-stem '
            '(vocals + instrumental) rather than full six-stem splits.'
        ),
        quality='Highest per stem',
        speed='Moderate',
        params=[
            Param('model_filename', 'Model', 'model', DEFAULT_ROFORMER_MODEL, group='Model',
                  help='Model filename from the audio-separator catalog. The architecture is '
                       'inferred from the checkpoint, so only that architecture\'s parameter '
                       'group below applies.'),
            Param('single_stem', 'Single stem only', 'str', '', group='Model', advanced=True,
                  help='Emit just one stem, e.g. "Vocals" or "Instrumental". Blank = all stems '
                       'the model produces.'),
            *_mdxc_params(),
            *_mdx_params(),
            # No Demucs parameter group here on purpose: audio-separator's
            # Demucs bridge is filtered out of the catalog (see
            # audio_separator_catalog), so no selectable model would use it.
            # The dedicated `demucs` engine owns those knobs.
            *_vr_params(),
            *_common_params(),
        ],
    ),
    'demucs': Engine(
        key='demucs',
        label='Demucs — Hybrid Transformer',
        description=(
            'The original engine. The only one that produces six instrument stems in a single '
            'pass, and the fastest of the three. Vocals are noticeably behind Roformer.'
        ),
        quality='Good',
        speed='Fastest',
        params=[
            *_demucs_params(),
            Param('output_format', 'Intermediate format', 'enum', 'wav', group='Output',
                  options=['wav', 'flac', 'mp3'],
                  help='Format Demucs writes before Jamsesh transcodes to OGG.'),
            Param('two_stems', 'Two-stem mode', 'str', '', group='Output', advanced=True,
                  help='Emit only this stem and its complement, e.g. "vocals" gives '
                       'vocals + no_vocals. Blank = all stems.'),
        ],
    ),
}


def engine_catalog() -> list[dict]:
    """Serializable engine + parameter schema for the frontend."""
    return [asdict(ENGINES[k]) for k in ('hybrid', 'audio-separator', 'demucs')]


def default_params(engine: str) -> dict[str, Any]:
    spec = ENGINES.get(engine)
    if spec is None:
        return {}
    return {p.key: p.default for p in spec.params}


# ─────────────────────────────────────────────────────────────────────────────
# audio-separator model catalog
# ─────────────────────────────────────────────────────────────────────────────

_CATALOG_CACHE: list[dict] | None = None


def model_file_dir() -> Path:
    """Where downloaded checkpoints live.

    Deliberately *not* audio-separator's ``/tmp/audio-separator-models`` default:
    these files are hundreds of MB each and several Linux distros wipe /tmp on
    reboot, which would re-download the whole set after every restart. Same
    reasoning as the ``upload_dir`` note in config.py.
    """
    configured = getattr(settings, 'audio_separator_model_dir', '') or ''
    path = Path(configured) if configured else Path(settings.upload_dir) / 'audio-separator-models'
    path.mkdir(parents=True, exist_ok=True)
    return path


def _normalize_catalog(raw: Any) -> list[dict]:
    """Flatten ``Separator.list_supported_model_files()`` into a flat list.

    The shape of that return value has changed across audio-separator releases
    (bare filename strings, ``{filename: config_yaml}`` pairs, and richer dicts
    carrying stems and SDR scores have all shipped). Rather than pin a version,
    accept all of them and fall back to whatever can be recovered — a model
    that lands here with no stem metadata still separates fine, the UI just
    can't preview which stems it emits.
    """
    out: list[dict] = []
    if not isinstance(raw, dict):
        return out

    for arch, entries in raw.items():
        if not isinstance(entries, dict):
            continue
        for friendly_name, value in entries.items():
            filename: str | None = None
            stems: list[str] = []
            scores: dict[str, Any] = {}

            if isinstance(value, str):
                filename = value
            elif isinstance(value, dict):
                if 'filename' in value and isinstance(value['filename'], str):
                    filename = value['filename']
                    raw_stems = value.get('stems') or []
                    if isinstance(raw_stems, list):
                        stems = [str(s) for s in raw_stems]
                    if isinstance(value.get('scores'), dict):
                        scores = value['scores']
                else:
                    # Legacy {checkpoint: config_yaml} mapping — the checkpoint
                    # is the key, and there is exactly one useful key.
                    for k in value:
                        if isinstance(k, str) and k.lower().endswith(
                            ('.ckpt', '.onnx', '.pth', '.th', '.yaml', '.chpt')
                        ):
                            filename = k
                            break
                    if filename is None and value:
                        filename = str(next(iter(value)))

            if not filename:
                continue
            out.append({
                'filename': filename,
                'name': str(friendly_name),
                'arch': str(arch),
                'stems': stems,
                'scores': scores,
            })
    return out


def audio_separator_catalog(refresh: bool = False) -> dict:
    """Live model catalog, cached per process.

    Returns ``{'available': bool, 'models': [...], 'error': str}``. When
    audio-separator is not installed this reports ``available: False`` with the
    reason instead of raising, so the Demucs engine keeps working and the UI
    can explain what to install — mirroring how the V2 pipeline lets optional
    engines drop out of its catalog.
    """
    global _CATALOG_CACHE
    if _CATALOG_CACHE is not None and not refresh:
        return {'available': True, 'models': _CATALOG_CACHE, 'error': ''}

    try:
        from audio_separator.separator import Separator
    except Exception as e:  # ImportError, or a broken optional dep chain
        return {
            'available': False,
            'models': [],
            'error': f'audio-separator is not installed ({e}). '
                     f'Install it with: pip install "audio-separator[cpu]"',
        }

    try:
        sep = Separator(info_only=True, log_level=logging.ERROR, model_file_dir=str(model_file_dir()))
        models = _normalize_catalog(sep.list_supported_model_files())
    except Exception as e:
        return {'available': True, 'models': [], 'error': f'Could not read model catalog: {e}'}

    # Drop audio-separator's own Demucs bridge. It imports diffq, which we
    # deliberately don't install (its sdist no longer builds — see
    # requirements-extras.txt), so those entries would fail at load time. They
    # are redundant anyway: the standalone `demucs` engine runs the same models
    # and is the only path wired for six-stem game-ready output.
    models = [m for m in models if m['arch'].lower() != 'demucs']

    models.sort(key=lambda m: (m['arch'], m['name']))
    _CATALOG_CACHE = models
    return {'available': True, 'models': models, 'error': ''}


def model_stems(model_filename: str) -> list[str]:
    """Declared stem names for a model, or [] when unknown."""
    cat = audio_separator_catalog()
    for m in cat['models']:
        if m['filename'] == model_filename:
            return m['stems']
    return []


# audio-separator names stems in title case ("Vocals", "Instrumental"); the
# rest of the app speaks Demucs' lowercase vocabulary. Normalize on the way in
# so finalize_game_ready's DEMUCS_TO_GAME mapping applies unchanged.
_AS_TO_DEMUCS = {
    'vocals': 'vocals',
    'vocal': 'vocals',
    'lead vocals': 'vocals',
    'instrumental': 'other',
    'instrument': 'other',
    'drums': 'drums',
    'drum': 'drums',
    'bass': 'bass',
    'guitar': 'guitar',
    'piano': 'piano',
    'keyboards': 'piano',
    'other': 'other',
    'no vocals': 'other',
}


def _normalize_stem_name(name: str) -> str:
    return _AS_TO_DEMUCS.get(name.strip().lower(), name.strip().lower().replace(' ', '_'))


def _custom_output_names(declared: list[str]) -> dict[str, str] | None:
    """Force deterministic output filenames for a model's declared stems.

    The catalog reports stem names lowercase ("vocals") while the separator
    labels its outputs in title case ("Vocals"), and which one
    ``--custom_output_names`` is keyed on has moved between releases. Emitting
    every casing costs nothing — unmatched keys are ignored — and saves us from
    falling back to filename parsing.
    """
    names: dict[str, str] = {}
    for stem in declared:
        target = _normalize_stem_name(stem)
        for variant in (stem, stem.lower(), stem.title(), stem.capitalize()):
            names[variant] = target
    return names or None


# ─────────────────────────────────────────────────────────────────────────────
# audio-separator subprocess runner
# ─────────────────────────────────────────────────────────────────────────────

_AUDIO_EXTS = {'.wav', '.flac', '.mp3', '.m4a', '.ogg'}

# Run the CLI's main() through -c rather than `-m audio_separator.utils.cli`.
# The module has no __main__ guard in every release, and the `audio-separator`
# console script is not guaranteed to be on PATH when the backend runs under
# systemd. Args after -c land in sys.argv[1:], which is exactly what argparse
# reads, so main() sees them unchanged.
_CLI_BOOTSTRAP = 'import sys; from audio_separator.utils.cli import main; sys.argv[0] = "audio-separator"; main()'


def _flag_args(params: dict, spec_keys: set[str]) -> list[str]:
    """Translate the parameter dict into audio-separator CLI flags.

    Booleans are store_true flags (emitted only when set); ``0``/blank values
    for the optional numeric/string knobs mean "leave at the tool's default"
    and are skipped so we never pass a meaningless ``--chunk_duration 0``.
    """
    args: list[str] = []
    bool_flags = {
        'invert_spect', 'use_soundfile', 'use_autocast',
        'mdx_enable_denoise', 'mdxc_override_model_segment_size',
        'vr_enable_tta', 'vr_enable_post_process', 'vr_high_end_process',
    }
    skip_if_falsy = {'output_bitrate', 'chunk_duration', 'single_stem'}

    for key in sorted(spec_keys):
        if key not in params:
            continue
        value = params[key]
        if key in bool_flags:
            if value:
                args.append(f'--{key}')
            continue
        if key in skip_if_falsy and not value:
            continue
        if value is None or value == '':
            continue
        args.extend([f'--{key}', str(value)])
    return args


async def _stream_audio_separator(
    audio_path: Path,
    output_dir: Path,
    params: dict,
    progress_callback,
    set_process=None,
    *,
    progress_lo: int = 10,
    progress_hi: int = 85,
    label: str = 'separator',
    custom_output_names: dict[str, str] | None = None,
) -> None:
    """Run audio-separator as a subprocess, streaming tqdm progress."""
    cli_keys = {
        'model_filename', 'output_format', 'output_bitrate', 'normalization',
        'amplification', 'single_stem', 'sample_rate', 'invert_spect',
        'use_soundfile', 'use_autocast', 'chunk_duration',
        'mdx_segment_size', 'mdx_overlap', 'mdx_batch_size', 'mdx_hop_length',
        'mdx_enable_denoise',
        'vr_batch_size', 'vr_window_size', 'vr_aggression', 'vr_enable_tta',
        'vr_enable_post_process', 'vr_post_process_threshold', 'vr_high_end_process',
        'mdxc_segment_size', 'mdxc_override_model_segment_size', 'mdxc_overlap',
        'mdxc_batch_size', 'mdxc_pitch_shift',
    }

    cmd = [
        sys.executable, '-u', '-c', _CLI_BOOTSTRAP,
        '--output_dir', str(output_dir),
        '--model_file_dir', str(model_file_dir()),
        '--log_level', 'info',
    ]
    cmd += _flag_args(params, cli_keys)
    if custom_output_names:
        cmd += ['--custom_output_names', json.dumps(custom_output_names)]
    cmd.append(str(audio_path))

    if progress_callback:
        shown = ' '.join(c if c != _CLI_BOOTSTRAP else 'audio-separator' for c in cmd[3:])
        await progress_callback(label, max(1, progress_lo - 2), f'$ audio-separator {shown}')

    child_env = separator_child_env()
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=child_env,
    )
    if set_process is not None:
        set_process(proc)

    tail: list[str] = []

    async def _pump(stream: asyncio.StreamReader):
        buf = ''
        while True:
            chunk = await stream.read(256)
            if not chunk:
                break
            buf += chunk.decode('utf-8', errors='replace')
            while '\n' in buf or '\r' in buf:
                line, _, buf = buf.partition('\n') if '\n' in buf else buf.partition('\r')
                line = line.strip()
                if not line:
                    continue
                tail.append(line)
                del tail[:-40]
                if not progress_callback:
                    continue
                m = _PROGRESS_RE.search(line)
                if m:
                    pct = int(m.group(1))
                    mapped = progress_lo + int((progress_hi - progress_lo) * pct / 100)
                    await progress_callback(label, mapped, f'{pct}% — {label}')
                else:
                    await progress_callback('log', -1, line)
        if buf.strip():
            tail.append(buf.strip())
            if progress_callback:
                await progress_callback('log', -1, buf.strip())

    await asyncio.gather(_pump(proc.stderr), _pump(proc.stdout))
    returncode = await proc.wait()
    if returncode != 0:
        raise RuntimeError('audio-separator failed (exit {}):\n{}'.format(returncode, '\n'.join(tail[-12:])))


def _collect_separator_outputs(output_dir: Path, expected: dict[str, str] | None) -> dict[str, str]:
    """Map audio-separator's output files to normalized stem names.

    When ``--custom_output_names`` was honoured the filenames are already the
    normalized stem names, so match those first. Anything left over is matched
    by audio-separator's default ``<track>_(Stem)_<model>.<ext>`` convention,
    and finally by bare filename, so an unexpected naming change degrades to a
    still-usable result rather than an empty one.
    """
    found: dict[str, str] = {}
    files = sorted(p for p in output_dir.iterdir() if p.is_file() and p.suffix.lower() in _AUDIO_EXTS)

    wanted = set((expected or {}).values())
    for path in files:
        if path.stem in wanted:
            found[path.stem] = path.name

    for path in files:
        if path.name in found.values():
            continue
        stem_label = None
        if '(' in path.stem and ')' in path.stem:
            stem_label = path.stem.split('(', 1)[1].split(')', 1)[0]
        name = _normalize_stem_name(stem_label) if stem_label else _normalize_stem_name(path.stem)
        if name and name not in found:
            found[name] = path.name
    return found


# ─────────────────────────────────────────────────────────────────────────────
# Engines
# ─────────────────────────────────────────────────────────────────────────────


def _apply_stem_filter(stem_files: dict[str, str], stems: list[str] | None) -> dict[str, str]:
    """Narrow the result to the requested stems.

    A filter that would leave nothing is ignored: two-stem models simply cannot
    honour a request for e.g. drums, and returning an empty track is worse than
    returning what the model actually produced.
    """
    if not stems:
        return stem_files
    kept = {k: v for k, v in stem_files.items() if k in set(stems)}
    return kept or stem_files


async def _run_audio_separator_engine(
    audio: Path,
    out: Path,
    params: dict,
    stems: list[str] | None,
    game_ready: bool,
    progress_callback,
    set_process,
) -> dict:
    model_filename = str(params.get('model_filename') or DEFAULT_ROFORMER_MODEL)
    fmt = 'WAV' if game_ready else str(params.get('output_format') or 'WAV')
    run_params = {**params, 'model_filename': model_filename, 'output_format': fmt}

    declared = model_stems(model_filename)
    custom_names = _custom_output_names(declared)

    if progress_callback:
        stem_note = ', '.join(declared) if declared else 'model default'
        await progress_callback('init', 4, f'Engine: audio-separator | Model: {model_filename} | Stems: {stem_note}')

    work = out / '_separator'
    work.mkdir(parents=True, exist_ok=True)
    await _stream_audio_separator(
        audio, work, run_params, progress_callback, set_process,
        progress_lo=8, progress_hi=85, label='separator',
        custom_output_names=custom_names,
    )

    if progress_callback:
        await progress_callback('collect', 86, 'Collecting stem files...')

    collected = _collect_separator_outputs(work, custom_names)
    if not collected:
        raise RuntimeError(f'audio-separator produced no recognisable stems in {work}')

    stem_files: dict[str, str] = {}
    for stem, filename in collected.items():
        dst = out / filename
        shutil.move(str(work / filename), str(dst))
        stem_files[stem] = dst.name
    shutil.rmtree(work, ignore_errors=True)
    stem_files = _apply_stem_filter(stem_files, stems)

    output_format = fmt.lower()
    if game_ready:
        stem_files = await finalize_game_ready(out, stem_files, audio, progress_callback)
        output_format = 'ogg'

    return {
        'stems': stem_files,
        'track_name': audio.stem,
        'engine': 'audio-separator',
        'model': model_filename,
        'output_format': output_format,
        'game_ready': game_ready,
    }


async def _run_hybrid_engine(
    audio: Path,
    out: Path,
    params: dict,
    stems: list[str] | None,
    game_ready: bool,
    progress_callback,
    set_process,
) -> dict:
    """Roformer vocals + Demucs instruments.

    Stage 1 runs the Roformer model and keeps both of its outputs: the vocal
    stem (which is the whole point) and the instrumental (which becomes stage
    2's input, so Demucs never sees the vocal and cannot smear it across the
    instrument stems).
    """
    vocal_model = str(params.get('vocal_model') or DEFAULT_ROFORMER_MODEL)
    demucs_model = str(params.get('model') or 'htdemucs_6s')
    instruments_from = str(params.get('instruments_from') or 'instrumental')

    if progress_callback:
        await progress_callback(
            'init', 3,
            f'Engine: hybrid | Vocals: {vocal_model} | Instruments: {demucs_model} '
            f'(from {instruments_from})',
        )

    # ── stage 1: Roformer vocal pass ────────────────────────────────────────
    stage1 = out / '_roformer'
    stage1.mkdir(parents=True, exist_ok=True)
    declared = model_stems(vocal_model)
    custom_names = _custom_output_names(declared)

    await _stream_audio_separator(
        audio, stage1,
        {**params, 'model_filename': vocal_model, 'output_format': 'WAV', 'single_stem': ''},
        progress_callback, set_process,
        progress_lo=6, progress_hi=45, label='roformer',
        custom_output_names=custom_names,
    )

    collected = _collect_separator_outputs(stage1, custom_names)
    vocal_src = next(
        (stage1 / f for s, f in collected.items() if s == 'vocals'),
        None,
    )
    instrumental_src = next(
        (stage1 / f for s, f in collected.items() if s != 'vocals'),
        None,
    )
    if vocal_src is None:
        raise RuntimeError(
            f'Roformer pass produced no vocal stem (got: {", ".join(collected) or "nothing"}). '
            f'Is "{vocal_model}" a vocals model?'
        )

    if progress_callback:
        await progress_callback('roformer', 46, f'Vocal pass done → {vocal_src.name}')

    # ── stage 2: Demucs instrument pass ─────────────────────────────────────
    if instruments_from == 'instrumental' and instrumental_src is not None:
        demucs_input = instrumental_src
    else:
        demucs_input = audio
        if instruments_from == 'instrumental' and progress_callback:
            await progress_callback(
                'log', -1,
                'Roformer emitted no instrumental stem — falling back to the original mix '
                'for the Demucs pass.',
            )

    segment = int(params.get('segment') or 0) or None
    await _stream_demucs(
        str(demucs_input), str(out), demucs_model, 'wav',
        int(params.get('mp3_bitrate') or 320),
        int(params.get('shifts') or 1),
        None,
        segment,
        float(params.get('overlap') or 0.25),
        str(params.get('clip_mode') or 'rescale'),
        int(params.get('jobs') or 0),
        progress_callback,
        set_process=set_process,
        progress_lo=48,
        progress_hi=85,
    )

    if progress_callback:
        await progress_callback('collect', 86, 'Collecting stem files...')

    available = MODEL_STEMS.get(demucs_model, MODEL_STEMS[DEFAULT_MODEL])
    # Demucs' own vocals stem is discarded: on the instrumental input it is
    # near-silent, and on the original input it is exactly the stem the
    # Roformer pass exists to beat.
    instrument_stems = [s for s in available if s != 'vocals']
    stem_files = collect_demucs_outputs(out, demucs_model, demucs_input.stem, 'wav', instrument_stems)

    vocals_dst = out / 'vocals.wav'
    shutil.move(str(vocal_src), str(vocals_dst))
    stem_files['vocals'] = vocals_dst.name
    shutil.rmtree(stage1, ignore_errors=True)

    stem_files = _apply_stem_filter(stem_files, stems)

    output_format = 'wav'
    if game_ready:
        stem_files = await finalize_game_ready(out, stem_files, audio, progress_callback)
        output_format = 'ogg'

    return {
        'stems': stem_files,
        'track_name': audio.stem,
        'engine': 'hybrid',
        'model': f'{vocal_model} + {demucs_model}',
        'output_format': output_format,
        'game_ready': game_ready,
    }


async def separate_with_engine(
    audio_path: str,
    output_dir: str,
    engine: str = DEFAULT_ENGINE,
    params: dict | None = None,
    stems: list[str] | None = None,
    game_ready: bool = False,
    progress_callback=None,
    set_process=None,
) -> dict:
    """Run stem separation with the named engine.

    ``params`` is a flat dict keyed by the :class:`Param` keys the engine
    declares; anything missing falls back to that parameter's default, so a
    caller can pass a partial dict (or none at all) and still get the
    max-quality configuration.
    """
    if engine not in ENGINES:
        raise ValueError(f'Unknown separation engine: {engine}. Use: {", ".join(ENGINES)}')

    merged = {**default_params(engine), **(params or {})}
    audio = Path(audio_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    if engine == 'demucs':
        model = str(merged.get('model') or DEFAULT_MODEL)
        segment = int(merged.get('segment') or 0) or None
        result = await separate_stems(
            audio_path=str(audio),
            output_dir=str(out),
            model=model,
            stems=stems,
            output_format=str(merged.get('output_format') or 'wav'),
            mp3_bitrate=int(merged.get('mp3_bitrate') or 320),
            shifts=int(merged.get('shifts') or 1),
            two_stems=str(merged.get('two_stems') or '') or None,
            segment=segment,
            overlap=float(merged.get('overlap') or 0.25),
            clip_mode=str(merged.get('clip_mode') or 'rescale'),
            jobs=int(merged.get('jobs') or 0),
            game_ready=game_ready,
            progress_callback=progress_callback,
            set_process=set_process,
        )
        result['params'] = merged
        return result

    if engine == 'audio-separator':
        result = await _run_audio_separator_engine(
            audio, out, merged, stems, game_ready, progress_callback, set_process,
        )
    else:
        result = await _run_hybrid_engine(
            audio, out, merged, stems, game_ready, progress_callback, set_process,
        )

    if progress_callback:
        stem_list = ', '.join(f'{k} ({v})' for k, v in result['stems'].items())
        # Milestone, not the terminal event — see the same note in
        # stems.separate_stems. A step of 'done' here closes the SSE stream
        # before Job.send_done() fires with the real metadata.
        await progress_callback('finalize', 95, f'Stems ready: {stem_list}')

    await _write_peaks_file(result['stems'], out, progress_callback)
    result['params'] = merged
    return result
