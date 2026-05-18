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

    studio_username: str = 'admin'
    studio_password: str = 'SlayTheStage'

    elevenlabs_api_key: str = ''

    madmom_root: str = str(Path(__file__).resolve().parents[4])

    # Default chart-generation model the editor offers when creating a new
    # beatmap. 'madmom' = legacy CloneHeroChartGenerator path; 'v2' = the new
    # modular pipeline (see web/backend/app/services/pipeline/). Flip to 'v2'
    # once V2 has been validated on enough songs.
    beatmap_model_default: str = 'madmom'

    # Path to the Unity project the editor pulls 3D gem meshes from. Points
    # at the local checkout by default; overrideable per environment.
    jamseshquest_gems_dir: str = str(
        Path('C:/Users/Admin/Documents/GitHub/jamseshquest/Assets/Art/Models/Gems'),
    )
    # Highway floor textures (looped onto the 3D runway plane).
    jamseshquest_highways_dir: str = str(
        Path('C:/Users/Admin/Documents/GitHub/jamseshquest/Assets/Art/Textures/Highways'),
    )

    model_config = {
        'env_file': os.getenv('BEATMAP_ENV', str(Path(__file__).resolve().parents[2] / '.env')),
        'extra': 'ignore',
    }

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(',') if o.strip()]

    @property
    def bin_dir(self) -> Path:
        return Path(self.madmom_root) / 'bin'


settings = Settings()
