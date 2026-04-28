"""In-memory job store with SSE support, disk persistence, and event-log replay.

Each job is mirrored to ``<upload_dir>/jobs/<id>.json`` after every event so that
- a browser that closes mid-job can re-attach by URL on any machine,
- a backend restart sees the record (running jobs are flipped to FAILED since the
  worker thread is gone),
- the Studio Library can list active/recent jobs without scraping memory state.
"""

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from ..config import settings


class JobStatus(str, Enum):
    QUEUED = 'queued'
    RUNNING = 'running'
    DONE = 'done'
    FAILED = 'failed'
    CANCELLED = 'cancelled'


class JobKind(str, Enum):
    SEPARATE = 'separate'
    MANUAL_STEMS = 'manual_stems'
    BEATMAP = 'beatmap'
    OTHER = 'other'


_EVENT_LOG_LIMIT = 500
_TERMINAL = (JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED)


def _jobs_dir() -> Path:
    d = Path(settings.upload_dir) / 'jobs'
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class Job:
    id: str
    kind: JobKind = JobKind.SEPARATE
    title: str = ''
    status: JobStatus = JobStatus.QUEUED
    progress: int = 0
    last_message: str = ''
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    output_dir: Optional[Path] = None
    error: Optional[str] = None
    metadata: dict = field(default_factory=dict)
    event_log: list[dict] = field(default_factory=list)
    track_id: Optional[str] = None
    beatmap_id: Optional[str] = None
    # Runtime-only — never persisted
    cancelled: bool = field(default=False, repr=False)
    process: Any = field(default=None, repr=False)
    task: Any = field(default=None, repr=False)
    _queues: list[asyncio.Queue] = field(default_factory=list, repr=False)

    # ------------------------------------------------------------------ I/O

    def _persist_path(self) -> Path:
        return _jobs_dir() / f'{self.id}.json'

    def to_dict(self) -> dict:
        kind = self.kind.value if isinstance(self.kind, JobKind) else self.kind
        status = self.status.value if isinstance(self.status, JobStatus) else self.status
        return {
            'id': self.id,
            'kind': kind,
            'title': self.title,
            'status': status,
            'progress': self.progress,
            'last_message': self.last_message,
            'created_at': self.created_at,
            'updated_at': self.updated_at,
            'finished_at': self.finished_at,
            'error': self.error,
            'metadata': self.metadata,
            'track_id': self.track_id or self.metadata.get('track_id'),
            'beatmap_id': self.beatmap_id or self.metadata.get('beatmap_id'),
            'output_dir': str(self.output_dir) if self.output_dir else None,
        }

    def _persist(self) -> None:
        try:
            data = {**self.to_dict(), 'event_log': self.event_log[-_EVENT_LOG_LIMIT:]}
            self._persist_path().write_text(json.dumps(data, default=str))
        except OSError as e:
            print(f'[jobs] persist failed for {self.id}: {e}')

    @classmethod
    def from_dict(cls, data: dict) -> 'Job':
        return cls(
            id=data['id'],
            kind=JobKind(data.get('kind', 'separate')),
            title=data.get('title', ''),
            status=JobStatus(data.get('status', 'queued')),
            progress=int(data.get('progress', 0)),
            last_message=data.get('last_message', ''),
            created_at=float(data.get('created_at', time.time())),
            updated_at=float(data.get('updated_at', time.time())),
            finished_at=data.get('finished_at'),
            output_dir=Path(data['output_dir']) if data.get('output_dir') else None,
            error=data.get('error'),
            metadata=data.get('metadata', {}),
            event_log=data.get('event_log', []),
            track_id=data.get('track_id'),
            beatmap_id=data.get('beatmap_id'),
        )

    # --------------------------------------------------------- Subscription

    def subscribe(self) -> asyncio.Queue:
        """Return a queue pre-loaded with the existing event log.

        Any subscriber — including one re-attaching after a browser refresh — gets
        the full stream from the beginning, then either parks waiting for new
        events (still running) or drains the queued sentinel and disconnects
        (terminal status).
        """
        q: asyncio.Queue = asyncio.Queue()
        for e in self.event_log:
            q.put_nowait(e)
        if self.status in _TERMINAL:
            q.put_nowait(None)
        else:
            self._queues.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._queues.remove(q)
        except ValueError:
            pass

    # -------------------------------------------------------------- Events

    def _record_event(self, event: dict) -> None:
        self.event_log.append(event)
        if len(self.event_log) > _EVENT_LOG_LIMIT:
            self.event_log = self.event_log[-_EVENT_LOG_LIMIT:]
        msg = event.get('message')
        if msg:
            self.last_message = msg
        if event.get('progress', -1) >= 0:
            self.progress = event['progress']
        self.updated_at = time.time()

    async def send(self, step: str, progress: int, message: str) -> None:
        if self.status == JobStatus.QUEUED:
            self.status = JobStatus.RUNNING
        event = {'step': step, 'progress': progress, 'message': message}
        self._record_event(event)
        self._persist()
        for q in list(self._queues):
            await q.put(event)

    async def send_done(self, metadata: dict | None = None) -> None:
        if metadata:
            self.metadata.update(metadata)
        if not self.track_id:
            self.track_id = self.metadata.get('track_id')
        if not self.beatmap_id:
            self.beatmap_id = self.metadata.get('beatmap_id')
        self.status = JobStatus.DONE
        self.progress = 100
        self.finished_at = time.time()
        event = {'step': 'done', 'progress': 100, 'message': 'Complete', 'metadata': self.metadata}
        self._record_event(event)
        self._persist()
        for q in list(self._queues):
            await q.put(event)
            await q.put(None)

    async def send_error(self, error: str) -> None:
        self.status = JobStatus.FAILED
        self.error = error
        self.finished_at = time.time()
        event = {'step': 'error', 'progress': -1, 'message': error}
        self._record_event(event)
        self._persist()
        for q in list(self._queues):
            await q.put(event)
            await q.put(None)

    async def cancel(self) -> None:
        if self.cancelled or self.status in _TERMINAL:
            return
        self.cancelled = True
        proc = self.process
        if proc is not None and getattr(proc, 'returncode', None) is None:
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass
        if self.task is not None and not self.task.done():
            self.task.cancel()
        self.status = JobStatus.CANCELLED
        self.finished_at = time.time()
        event = {'step': 'cancelled', 'progress': -1, 'message': 'Cancelled by user'}
        self._record_event(event)
        self._persist()
        for q in list(self._queues):
            await q.put(event)
            await q.put(None)


# Global job store — keyed by id, populated on creation and at startup
_jobs: dict[str, Job] = {}


def create_job(kind: JobKind | str = JobKind.SEPARATE, title: str = '') -> Job:
    if isinstance(kind, str):
        kind = JobKind(kind)
    job = Job(id=uuid.uuid4().hex[:12], kind=kind, title=title)
    _jobs[job.id] = job
    job._persist()
    return job


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def list_jobs() -> list[Job]:
    return sorted(_jobs.values(), key=lambda j: j.created_at, reverse=True)


def load_jobs_from_disk() -> None:
    """Read every persisted job record. RUNNING/QUEUED records are flipped to
    FAILED with a clear error since the worker thread/task is gone."""
    d = _jobs_dir()
    for p in d.glob('*.json'):
        try:
            data = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError) as e:
            print(f'[jobs] failed to load {p.name}: {e}')
            continue
        job = Job.from_dict(data)
        if job.status in (JobStatus.QUEUED, JobStatus.RUNNING):
            job.status = JobStatus.FAILED
            job.error = job.error or 'Backend restarted while job was running'
            if job.finished_at is None:
                job.finished_at = time.time()
            event = {'step': 'error', 'progress': -1, 'message': job.error}
            job._record_event(event)
            job._persist()
        _jobs[job.id] = job


def cleanup_old_jobs(ttl_minutes: int) -> None:
    """Drop terminal jobs older than ttl_minutes. Running jobs are kept regardless
    of age — they're load-bearing for the user's live progress view.

    The transient ``output_dir`` (uploads/<job_id>) is also purged. Track stems
    and beatmap folders have already been copied into ``_tracks/<track_id>``
    by their respective workers, so those persistent artefacts survive."""
    import shutil

    cutoff = time.time() - ttl_minutes * 60
    to_remove = [
        jid for jid, j in _jobs.items()
        if j.created_at < cutoff and j.status in _TERMINAL
    ]
    for jid in to_remove:
        job = _jobs.pop(jid)
        if job.output_dir and job.output_dir.exists():
            shutil.rmtree(job.output_dir, ignore_errors=True)
        try:
            job._persist_path().unlink(missing_ok=True)
        except OSError:
            pass
