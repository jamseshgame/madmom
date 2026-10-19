"""SongGrid — output of S1 (grid detection)."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..types import StageOutputBase


class TempoSegment(BaseModel):
    tick_start: int = Field(ge=0)
    # Lead-in segments before the first beat may be fast (see beat_grid).
    micro_bpm: int = Field(ge=20_000, le=1_000_000)
    label: Optional[str] = None


class TimeSigSegment(BaseModel):
    tick_start: int = Field(ge=0)
    num: int = Field(ge=1, le=16)
    denom_pow: int = Field(ge=0, le=4)


class Section(BaseModel):
    tick_start: int = Field(ge=0)
    label: str


class DetectedKey(BaseModel):
    tonic: str
    mode: str
    confidence: float = Field(ge=0.0, le=1.0)


class SongGrid(StageOutputBase):
    audio_duration_s: float = Field(gt=0)
    resolution: int = Field(default=192, ge=1)
    tempo_segments: list[TempoSegment]
    time_sig_segments: list[TimeSigSegment]
    downbeats: list[int]
    sections: list[Section]
    detected_key: Optional[DetectedKey] = None

    model_config = ConfigDict(extra='allow')

    @field_validator('tempo_segments')
    @classmethod
    def _strictly_increasing_tempo(cls, v):
        if not v:
            raise ValueError('tempo_segments must be non-empty')
        prev = -1
        for seg in v:
            if seg.tick_start <= prev:
                raise ValueError('tick_start must be strictly increasing across tempo_segments')
            prev = seg.tick_start
        return v

    @model_validator(mode='after')
    def _segments_align_to_beats(self):
        """Tempo changes must sit on a downbeat or on a beat line.

        The constant-tempo engines only ever change tempo on downbeats; the
        beat-anchored engines (beat_grid) emit one segment per run of
        near-constant tempo, which may start on any beat."""
        if not self.downbeats:
            return self
        downbeat_set = set(self.downbeats)
        for seg in self.tempo_segments:
            if seg.tick_start == 0:
                continue
            if seg.tick_start in downbeat_set or seg.tick_start % self.resolution == 0:
                continue
            raise ValueError(
                f'tempo_segment tick_start={seg.tick_start} is not on a beat or downbeat'
            )
        return self
