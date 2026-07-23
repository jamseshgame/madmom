"""Tests for the multi-engine stem separation layer (app.services.separators).

Everything here is pure — no model downloads, no subprocesses. The parts that
actually matter for correctness are the parameter schema (which the frontend
renders verbatim), the CLI flag translation, the catalog normalization across
audio-separator's several historical JSON shapes, and the output collection.
"""
from __future__ import annotations

import pytest

from app.services import separators as S


class TestEngineCatalog:
    def test_exposes_three_engines_hybrid_first(self):
        catalog = S.engine_catalog()
        assert [e['key'] for e in catalog] == ['hybrid', 'audio-separator', 'demucs']

    def test_default_engine_is_max_quality_hybrid(self):
        assert S.DEFAULT_ENGINE == 'hybrid'

    def test_every_param_is_json_serializable_and_well_formed(self):
        for engine in S.engine_catalog():
            assert engine['params'], f'{engine["key"]} exposes no parameters'
            for p in engine['params']:
                assert p['key'] and p['label'], p
                assert p['type'] in {'int', 'float', 'bool', 'enum', 'str', 'model'}, p
                if p['type'] == 'enum':
                    assert p['options'], f'enum {p["key"]} has no options'
                    assert p['default'] in p['options'], p
                if p['minimum'] is not None and p['maximum'] is not None:
                    assert p['minimum'] <= p['default'] <= p['maximum'], p

    def test_param_keys_unique_within_each_engine(self):
        for engine in S.engine_catalog():
            keys = [p['key'] for p in engine['params']]
            assert len(keys) == len(set(keys)), f'{engine["key"]} has duplicate param keys'

    def test_every_param_has_help_text(self):
        # "Show all settings and variables" only helps if each one is explained.
        for engine in S.engine_catalog():
            for p in engine['params']:
                assert p['help'].strip(), f'{engine["key"]}.{p["key"]} has no help text'

    def test_defaults_cover_every_declared_param(self):
        for key, spec in S.ENGINES.items():
            defaults = S.default_params(key)
            assert set(defaults) == {p.key for p in spec.params}

    def test_defaults_are_max_quality(self):
        hybrid = S.default_params('hybrid')
        assert hybrid['shifts'] == 10, 'shifts should default to the max-quality end'
        assert hybrid['overlap'] == 0.75
        assert hybrid['use_autocast'] is False, 'autocast trades quality for speed'
        assert hybrid['instruments_from'] == 'instrumental'

        as_engine = S.default_params('audio-separator')
        assert as_engine['vr_enable_tta'] is True
        assert as_engine['mdx_enable_denoise'] is True

    def test_unknown_engine_rejected(self):
        assert S.default_params('nope') == {}


class TestFlagArgs:
    KEYS = {
        'model_filename', 'mdxc_overlap', 'vr_enable_tta', 'mdx_enable_denoise',
        'chunk_duration', 'output_bitrate', 'single_stem', 'normalization',
        'demucs_segments_enabled',
    }

    def test_store_true_flags_emitted_only_when_set(self):
        on = S._flag_args({'vr_enable_tta': True}, self.KEYS)
        assert on == ['--vr_enable_tta']
        assert S._flag_args({'vr_enable_tta': False}, self.KEYS) == []

    def test_value_flags_emit_key_and_value(self):
        args = S._flag_args({'mdxc_overlap': 8, 'normalization': 0.9}, self.KEYS)
        assert args == ['--mdxc_overlap', '8', '--normalization', '0.9']

    def test_optional_knobs_skipped_when_falsy(self):
        # A literal `--chunk_duration 0` means something different to
        # audio-separator than "leave it alone", so 0 must not be passed.
        args = S._flag_args(
            {'chunk_duration': 0, 'output_bitrate': '', 'single_stem': ''}, self.KEYS,
        )
        assert args == []

    def test_optional_knobs_passed_when_set(self):
        args = S._flag_args({'chunk_duration': 30.0, 'single_stem': 'Vocals'}, self.KEYS)
        assert '--chunk_duration' in args and '30.0' in args
        assert '--single_stem' in args and 'Vocals' in args

    def test_non_boolean_true_valued_flag_passes_its_value(self):
        # --demucs_segments_enabled takes a value rather than being store_true.
        assert S._flag_args({'demucs_segments_enabled': True}, self.KEYS) == [
            '--demucs_segments_enabled', 'True',
        ]

    def test_keys_outside_the_spec_are_ignored(self):
        # Demucs-engine keys share names with nothing on the CLI; they must not
        # leak through as bogus flags.
        assert S._flag_args({'shifts': 10, 'clip_mode': 'rescale'}, self.KEYS) == []


class TestCatalogNormalization:
    def test_rich_shape(self):
        raw = {'MDXC': {'BS-Roformer': {
            'filename': 'bs.ckpt', 'stems': ['vocals', 'instrumental'],
            'scores': {'vocals': {'SDR': 12.9}},
        }}}
        out = S._normalize_catalog(raw)
        assert out == [{
            'filename': 'bs.ckpt', 'name': 'BS-Roformer', 'arch': 'MDXC',
            'stems': ['vocals', 'instrumental'], 'scores': {'vocals': {'SDR': 12.9}},
        }]

    def test_legacy_checkpoint_to_config_mapping(self):
        raw = {'roformer_download_list': {'Mel Roformer': {'mel.ckpt': 'mel_config.yaml'}}}
        out = S._normalize_catalog(raw)
        assert out[0]['filename'] == 'mel.ckpt'
        assert out[0]['stems'] == []

    def test_bare_filename_string(self):
        out = S._normalize_catalog({'VR': {'UVR 1_HP': '1_HP-UVR.pth'}})
        assert out[0]['filename'] == '1_HP-UVR.pth'

    def test_malformed_input_yields_empty_list(self):
        assert S._normalize_catalog(None) == []
        assert S._normalize_catalog({'MDXC': 'not a dict'}) == []
        assert S._normalize_catalog({'MDXC': {'x': {}}}) == []


class TestStemNaming:
    @pytest.mark.parametrize('raw,expected', [
        ('Vocals', 'vocals'),
        ('vocals', 'vocals'),
        ('Instrumental', 'other'),
        ('No Vocals', 'other'),
        ('Drums', 'drums'),
        ('Bass', 'bass'),
        ('Keyboards', 'piano'),
        ('Weird Stem', 'weird_stem'),
    ])
    def test_normalization(self, raw, expected):
        assert S._normalize_stem_name(raw) == expected

    def test_custom_output_names_cover_every_casing(self):
        names = S._custom_output_names(['vocals', 'instrumental'])
        # Whichever casing audio-separator uses internally, it maps to the same
        # deterministic output filename.
        for variant in ('vocals', 'Vocals', 'instrumental', 'Instrumental'):
            assert variant in names
        assert names['Vocals'] == 'vocals'
        assert names['Instrumental'] == 'other'

    def test_empty_declaration_yields_none(self):
        assert S._custom_output_names([]) is None


class TestCollectOutputs:
    def test_prefers_custom_named_files(self, tmp_path):
        (tmp_path / 'vocals.wav').write_bytes(b'')
        (tmp_path / 'other.wav').write_bytes(b'')
        found = S._collect_separator_outputs(
            tmp_path, {'Vocals': 'vocals', 'Instrumental': 'other'},
        )
        assert found == {'vocals': 'vocals.wav', 'other': 'other.wav'}

    def test_falls_back_to_default_naming_convention(self, tmp_path):
        # audio-separator's own convention when custom names don't take.
        (tmp_path / 'song_(Vocals)_bs_roformer.wav').write_bytes(b'')
        (tmp_path / 'song_(Instrumental)_bs_roformer.wav').write_bytes(b'')
        found = S._collect_separator_outputs(tmp_path, None)
        assert found == {
            'vocals': 'song_(Vocals)_bs_roformer.wav',
            'other': 'song_(Instrumental)_bs_roformer.wav',
        }

    def test_ignores_non_audio_files(self, tmp_path):
        (tmp_path / 'vocals.wav').write_bytes(b'')
        (tmp_path / 'peaks.json').write_text('{}')
        (tmp_path / 'notes.txt').write_text('x')
        assert S._collect_separator_outputs(tmp_path, {'Vocals': 'vocals'}) == {
            'vocals': 'vocals.wav',
        }


class TestStemFilter:
    def test_narrows_to_requested(self):
        files = {'vocals': 'v.wav', 'drums': 'd.wav', 'bass': 'b.wav'}
        assert S._apply_stem_filter(files, ['vocals', 'drums']) == {
            'vocals': 'v.wav', 'drums': 'd.wav',
        }

    def test_no_filter_is_a_passthrough(self):
        files = {'vocals': 'v.wav'}
        assert S._apply_stem_filter(files, None) == files
        assert S._apply_stem_filter(files, []) == files

    def test_filter_that_would_empty_the_result_is_ignored(self):
        # A two-stem model cannot produce drums; returning nothing would be a
        # worse answer than returning what the model did produce.
        files = {'vocals': 'v.wav', 'other': 'o.wav'}
        assert S._apply_stem_filter(files, ['drums', 'piano']) == files


class TestModelFileDir:
    def test_defaults_under_upload_dir_not_tmp(self, tmp_path, monkeypatch):
        from app.config import settings

        monkeypatch.setattr(settings, 'upload_dir', str(tmp_path / 'uploads'))
        monkeypatch.setattr(settings, 'audio_separator_model_dir', '')
        path = S.model_file_dir()
        assert path == tmp_path / 'uploads' / 'audio-separator-models'
        assert path.is_dir()

    def test_config_override_wins(self, tmp_path, monkeypatch):
        from app.config import settings

        monkeypatch.setattr(settings, 'audio_separator_model_dir', str(tmp_path / 'models'))
        assert S.model_file_dir() == tmp_path / 'models'


class TestDispatcher:
    @pytest.mark.asyncio
    async def test_rejects_unknown_engine(self, tmp_path):
        with pytest.raises(ValueError, match='Unknown separation engine'):
            await S.separate_with_engine(
                audio_path=str(tmp_path / 'a.wav'),
                output_dir=str(tmp_path / 'out'),
                engine='spleeter',
            )

    @pytest.mark.asyncio
    async def test_partial_params_are_merged_over_defaults(self, tmp_path, monkeypatch):
        seen = {}

        async def fake_separate_stems(**kwargs):
            seen.update(kwargs)
            return {'stems': {}, 'track_name': 'a', 'engine': 'demucs',
                    'model': kwargs['model'], 'output_format': 'wav', 'game_ready': False}

        monkeypatch.setattr(S, 'separate_stems', fake_separate_stems)
        result = await S.separate_with_engine(
            audio_path=str(tmp_path / 'a.wav'),
            output_dir=str(tmp_path / 'out'),
            engine='demucs',
            params={'shifts': 3},
        )
        assert seen['shifts'] == 3            # caller's value survives
        assert seen['overlap'] == 0.75        # default fills the gap
        assert seen['model'] == 'htdemucs_6s'
        assert result['params']['shifts'] == 3

    @pytest.mark.asyncio
    async def test_segment_zero_means_model_default(self, tmp_path, monkeypatch):
        seen = {}

        async def fake_separate_stems(**kwargs):
            seen.update(kwargs)
            return {'stems': {}, 'track_name': 'a', 'engine': 'demucs',
                    'model': 'htdemucs_6s', 'output_format': 'wav', 'game_ready': False}

        monkeypatch.setattr(S, 'separate_stems', fake_separate_stems)
        await S.separate_with_engine(
            audio_path=str(tmp_path / 'a.wav'),
            output_dir=str(tmp_path / 'out'),
            engine='demucs',
            params={'segment': 0},
        )
        assert seen['segment'] is None


class TestFfmpegLibDir:
    """torchcodec dlopen's libavcodec, and on Windows the DLL search only
    reliably reaches the front of PATH — so the separator subprocesses hoist
    the FFmpeg library directory there themselves rather than trusting the
    inherited ordering."""

    def _reset(self):
        from app.services import stems as stems_mod
        stems_mod.ffmpeg_lib_dir.cache_clear()

    def test_finds_directory_containing_shared_libs(self, tmp_path, monkeypatch):
        import os

        from app.services import stems as stems_mod

        other = tmp_path / 'somewhere'
        ff = tmp_path / 'ffmpeg' / 'bin'
        other.mkdir()
        ff.mkdir(parents=True)
        (ff / 'avcodec-62.dll').write_bytes(b'')

        self._reset()
        monkeypatch.setenv('PATH', os.pathsep.join([str(other), str(ff)]))
        assert stems_mod.ffmpeg_lib_dir() == str(ff)
        self._reset()

    def test_returns_none_when_no_shared_libs_on_path(self, tmp_path, monkeypatch):
        from app.services import stems as stems_mod

        self._reset()
        monkeypatch.setenv('PATH', str(tmp_path))
        assert stems_mod.ffmpeg_lib_dir() is None
        self._reset()

    def test_child_env_puts_lib_dir_first(self, tmp_path, monkeypatch):
        import os

        from app.services import stems as stems_mod

        ff = tmp_path / 'bin'
        ff.mkdir()
        (ff / 'libavcodec.so.61').write_bytes(b'')

        self._reset()
        monkeypatch.setenv('PATH', os.pathsep.join([str(tmp_path), str(ff)]))
        env = stems_mod.separator_child_env()
        assert env['PATH'].split(os.pathsep)[0] == str(ff)
        assert env['PYTHONUNBUFFERED'] == '1'
        assert env['PYTHONIOENCODING'] == 'utf-8'
        self._reset()

    def test_child_env_survives_missing_ffmpeg(self, tmp_path, monkeypatch):
        from app.services import stems as stems_mod

        self._reset()
        monkeypatch.setenv('PATH', str(tmp_path))
        env = stems_mod.separator_child_env()
        assert env['PYTHONUNBUFFERED'] == '1'
        self._reset()

    def test_nonexistent_path_entries_are_skipped(self, tmp_path, monkeypatch):
        import os

        from app.services import stems as stems_mod

        ff = tmp_path / 'bin'
        ff.mkdir()
        (ff / 'avcodec-62.dll').write_bytes(b'')

        self._reset()
        monkeypatch.setenv(
            'PATH', os.pathsep.join([str(tmp_path / 'gone'), '', '"quoted"', str(ff)]),
        )
        assert stems_mod.ffmpeg_lib_dir() == str(ff)
        self._reset()


class TestGracefulDegradation:
    def test_catalog_reports_missing_package_instead_of_raising(self, monkeypatch):
        import builtins

        real_import = builtins.__import__

        def blocked(name, *args, **kwargs):
            if name.startswith('audio_separator'):
                raise ImportError('No module named audio_separator')
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(S, '_CATALOG_CACHE', None)
        monkeypatch.setattr(builtins, '__import__', blocked)
        result = S.audio_separator_catalog(refresh=True)
        assert result['available'] is False
        assert result['models'] == []
        assert 'pip install' in result['error']

    def test_model_stems_returns_empty_for_unknown_model(self, monkeypatch):
        monkeypatch.setattr(
            S, 'audio_separator_catalog',
            lambda *a, **k: {'available': True, 'models': [], 'error': ''},
        )
        assert S.model_stems('nonexistent.ckpt') == []
