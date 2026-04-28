"""Job listing, status and SSE replay — works for any kind (separate, manual_stems, beatmap)."""

import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..services.jobs import JobStatus, get_job, list_jobs

router = APIRouter(prefix='/api/jobs', tags=['jobs'])


@router.get('')
async def get_all_jobs(active: bool = False, limit: int = 50, kind: str = ''):
    """List jobs newest first.

    Query params:
      - active=1   only QUEUED/RUNNING
      - kind=...   only this JobKind value (separate, manual_stems, beatmap)
      - limit      max rows (default 50)
    """
    jobs = list_jobs()
    if active:
        jobs = [j for j in jobs if j.status in (JobStatus.QUEUED, JobStatus.RUNNING)]
    if kind:
        jobs = [j for j in jobs if (j.kind.value if hasattr(j.kind, 'value') else j.kind) == kind]
    return [j.to_dict() for j in jobs[:limit]]


@router.get('/{job_id}')
async def get_job_detail(job_id: str):
    """Full job snapshot, with the most recent 200 events for re-hydration."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, 'Job not found')
    d = job.to_dict()
    d['event_log'] = job.event_log[-200:]
    return d


@router.get('/{job_id}/events')
async def stream_job_events(job_id: str):
    """SSE stream — replays the full event log on connect, then streams live events.

    Works for any job kind. Subscribers reconnecting to a still-running job
    catch up automatically; subscribers attaching after a job finished get the
    history then a final terminal event followed by EOF."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, 'Job not found')
    queue = job.subscribe()

    async def event_stream():
        try:
            while True:
                event = await asyncio.wait_for(queue.get(), timeout=900)
                if event is None:
                    break
                yield f'data: {json.dumps(event)}\n\n'
        except asyncio.TimeoutError:
            yield f'data: {json.dumps({"step": "error", "progress": -1, "message": "Idle timeout"})}\n\n'
        finally:
            job.unsubscribe(queue)

    return StreamingResponse(event_stream(), media_type='text/event-stream')


@router.post('/{job_id}/cancel')
async def cancel_job(job_id: str):
    """Best-effort cancel — kills any subprocess and marks the job CANCELLED."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, 'Job not found')
    await job.cancel()
    return {'cancelled': True, 'status': job.status.value}
