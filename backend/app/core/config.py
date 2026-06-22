import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic_settings import BaseSettings

# Load backend/.env before Settings() reads the environment, so values like
# DATABASE_URL / SECRET_KEY / CORS_ORIGINS are picked up. Path is resolved
# relative to this file (backend/app/core/config.py -> backend/.env) so it
# works regardless of the current working directory.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

class Settings(BaseSettings):
    PROJECT_NAME: str = "Authorization Spine API"
    API_STR: str = "/api"
    
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./auth_spine.db")
    
    SECRET_KEY: str = os.getenv("SECRET_KEY", "super-secret-development-key-change-in-production")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", str(60 * 24)))
    # Long-lived, server-stored refresh tokens (rotated on every /auth/refresh).
    REFRESH_TOKEN_EXPIRE_DAYS: int = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "30"))
    # Auto-run `alembic upgrade head` on startup (alembic is the single source of
    # truth for schema; set AUTO_MIGRATE=0 to manage migrations manually).
    AUTO_MIGRATE: bool = os.getenv("AUTO_MIGRATE", "1") not in ("0", "false", "False", "")

    # v1 is a single shared org (one team / tenant). Every signup joins this org.
    # org_id is the multi-tenant hook for the future; v1 just uses one fixed value.
    DEFAULT_ORG_ID: str = os.getenv("DEFAULT_ORG_ID", "00000000-0000-0000-0000-000000000001")

    # CORS allowed origins (the frontend's address). The browser blocks the
    # frontend from calling this API unless its origin is listed here.
    # Comma-separated; override via the CORS_ORIGINS env var in production.
    # Defaults cover the Next.js dev server (:3000) and a Vite fallback (:5173).
    CORS_ORIGINS: str = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173",
    )

    @property
    def cors_origins_list(self) -> list[str]:
        """CORS_ORIGINS parsed into a clean list of origins."""
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    class Config:
        case_sensitive = True

settings = Settings()