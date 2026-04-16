"""In-memory job store with SSE support via asyncio queues."""

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path


class JobStatus(str, Enum):
    QUEUED = 'queued'
    RUNNING = 'running'
    DONE = 'done'
    FAILED = 'failed'


@dataclass
class Job:
    id: str
    status: JobStatus = JobStatus.QUEUED
    created_at: float = field(default_factory=time.time)
    output_dir: Path | None = None
    error: str | None = None
    metadata: dict = field(default_factory=dict)
    # SSE subscribers
    _queues: list[asyncio.Queue] = field(default_factory=list, repr=False)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._queues.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        try:
            self._queues.remove(q)
        except ValueError:
            pass

    async def send(self, step: str, progress: int, message: str):
        event = {'step': step, 'progress': progress, 'message': message}
        for q in list(self._queues):
            await q.put(event)

    async def send_done(self, metadata: dict | None = None):
        if metadata:
            self.metadata.update(metadata)
        self.status = JobStatus.DONE
        for q in list(self._queues):
            await q.put({'step': 'done', 'progress': 100, 'message': 'Complete', 'metadata': self.metadata})
            await q.put(None)  # sentinel

    async def send_error(self, error: str):
        self.status = JobStatus.FAILED
        self.error = error
        for q in list(self._queues):
            await q.put({'step': 'error', 'progress': -1, 'message': error})
            await q.put(None)


# Global job store
_jobs: dict[str, Job] = {}


def create_job() -> Job:
    job = Job(id=uuid.uuid4().hex[:12])
    _jobs[job.id] = job
    return job


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def cleanup_old_jobs(ttl_minutes: int):
    """Remove jobs older than ttl_minutes and delete their output directories."""
    import shutil

    cutoff = time.time() - ttl_minutes * 60
    to_remove = [jid for jid, j in _jobs.items() if j.created_at < cutoff]
    for jid in to_remove:
        job = _jobs.pop(jid)
        if job.output_dir and job.output_dir.exists():
            shutil.rmtree(job.output_dir, ignore_errors=True)
