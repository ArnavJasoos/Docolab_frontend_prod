import os
from dotenv import load_dotenv
from pydantic_settings import BaseSettings

# Load backend/.env into os.environ BEFORE Settings reads its values, so the
# running app (run.py / uvicorn) picks up DATABASE_URL, SECRET_KEY, etc.
# This mirrors what alembic/env.py already does for migrations.
load_dotenv()

class Settings(BaseSettings):
    PROJECT_NAME: str = "Authorization Spine API"
    API_STR: str = "/api"
    
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./auth_spine.db")
    
    SECRET_KEY: str = os.getenv("SECRET_KEY", "super-secret-development-key-change-in-production")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24

    # v1 is a single shared org (one team / tenant). Every signup joins this org.
    # org_id is the multi-tenant hook for the future; v1 just uses one fixed value.
    DEFAULT_ORG_ID: str = os.getenv("DEFAULT_ORG_ID", "00000000-0000-0000-0000-000000000001")

    class Config:
        case_sensitive = True

settings = Settings()