"""FastAPI application for beatmap.jamsesh.co."""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .routers import analyse, beatmap
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

app.include_router(beatmap.router)
app.include_router(analyse.router)


@app.get('/api/health')
async def health():
    return {'status': 'ok'}
