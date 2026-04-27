"""FastAPI application for beatmap.jamsesh.co."""

import asyncio
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Windows requires the Proactor event loop for subprocess support (Demucs, ffmpeg)
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from fastapi import Depends

from .config import settings
from .routers import auth, beatmap, game_songs, stems, tracks, versions
from .routers.auth import require_auth
from .services.jobs import cleanup_old_jobs


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Cleanup timer that removes expired jobs every 10 minutes."""
    async def _cleanup_loop():
        while True:
            await asyncio.sleep(600)
            cleanup_old_jobs(settings.job_ttl_minutes)

    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()


app = FastAPI(
    title='Jamsesh Beatmap API',
    version='1.0.0',
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins_list,
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(auth.router)

_auth_dep = [Depends(require_auth)]
app.include_router(beatmap.router, dependencies=_auth_dep)
app.include_router(stems.router, dependencies=_auth_dep)
app.include_router(tracks.router, dependencies=_auth_dep)
app.include_router(versions.router, dependencies=_auth_dep)
app.include_router(game_songs.router, dependencies=_auth_dep)


@app.get('/api/health')
async def health():
    return {'status': 'ok'}
