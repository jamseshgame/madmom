"""Chart difficulty calibration — compare metrics across selected tracks."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..services.calibration import compute_calibration

router = APIRouter(prefix='/api/calibration', tags=['calibration'])


class CompareRequest(BaseModel):
    track_ids: list[str] = Field(default_factory=list, max_length=2000)


@router.post('/compare')
def compare(req: CompareRequest) -> dict:
    return compute_calibration(req.track_ids)
