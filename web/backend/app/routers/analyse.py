"""Chart analysis endpoint."""

from fastapi import APIRouter, HTTPException, UploadFile

from ..services.chart_analyser import analyse_chart_file

router = APIRouter(prefix='/api', tags=['analyse'])


@router.post('/analyse')
async def analyse_chart(file: UploadFile):
    """Upload a .chart file and get per-difficulty stats."""
    if not (file.filename or '').lower().endswith('.chart'):
        raise HTTPException(400, 'File must be a .chart file')

    content = (await file.read()).decode('utf-8', errors='replace')
    if not content.strip():
        raise HTTPException(400, 'Empty file')

    try:
        result = analyse_chart_file(content)
    except Exception as e:
        raise HTTPException(422, f'Failed to parse chart: {e}')

    return result
