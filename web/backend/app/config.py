import os
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    host: str = '0.0.0.0'
    port: int = 8000
    allowed_origins: str = 'https://beatmap.jamsesh.co,http://localhost:5173'

    upload_dir: str = '/tmp/beatmap-uploads'
    max_upload_mb: int = 200
    job_ttl_minutes: int = 60

    github_token: str = ''
    github_owner: str = 'jamseshgame'
    github_repo: str = 'JamseshSongContent'
    github_branch: str = 'main'
    github_inbox_prefix: str = 'SongInbox'

    madmom_root: str = str(Path(__file__).resolve().parents[4])

    model_config = {'env_file': os.getenv('BEATMAP_ENV', '.env'), 'extra': 'ignore'}

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(',') if o.strip()]

    @property
    def bin_dir(self) -> Path:
        return Path(self.madmom_root) / 'bin'


settings = Settings()
