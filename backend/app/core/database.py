# =============================================================================
# app/core/database.py
# Async SQLAlchemy engine + session factory for FastAPI.
#
# HOW IT WORKS:
#   - Reads DATABASE_URL from the environment (set in .env at backend/)
#   - Creates an async engine using asyncpg as the driver
#   - Every API request gets its own session via get_db() dependency
#   - Base is imported by database_models.py so all models register here
# =============================================================================

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

# Load backend/.env so DATABASE_URL is available no matter how the app is
# launched (run.py, uvicorn, tests). Idempotent — safe even though config.py
# also calls it.
load_dotenv()

# ---------------------------------------------------------------------------
# Load environment from backend/.env
# ---------------------------------------------------------------------------
# Load the .env file BEFORE reading DATABASE_URL so a local .env is picked up
# when running the app (uvicorn). The path is resolved relative to this file
# (backend/app/core/database.py -> backend/.env) so it works regardless of the
# current working directory. Real environment variables still take precedence.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

# ---------------------------------------------------------------------------
# Connection URL
# ---------------------------------------------------------------------------
# Reads from environment. In development, set this in backend/.env:
#   DATABASE_URL=postgresql+asyncpg://postgres:yourpassword@localhost:5432/docplatform
#
# Note the driver prefix: postgresql+asyncpg (not plain postgresql://)
# asyncpg is the async Postgres driver FastAPI uses.

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/docplatform",
)

# Ensure the URL uses the asyncpg driver even if someone sets a plain
# postgresql:// URL in .env (common mistake).
if DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
elif DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+asyncpg://", 1)


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
# echo=False in production. Set echo=True temporarily to see SQL in the
# terminal while developing — useful for debugging queries.

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_size=10,          # number of connections kept open
    max_overflow=20,       # extra connections allowed under load
    pool_pre_ping=True,    # test connections before using (handles server restarts)
)


# ---------------------------------------------------------------------------
# Session factory
# ---------------------------------------------------------------------------
# Each call creates a new AsyncSession. expire_on_commit=False means you can
# still access model attributes after a commit without hitting the DB again.

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

SessionLocal = AsyncSessionLocal


# ---------------------------------------------------------------------------
# Base class for all models
# ---------------------------------------------------------------------------
# Every table in database_models.py inherits from this Base.
# SQLAlchemy uses it to track all models for Alembic migrations.

class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# FastAPI dependency: get_db()
# ---------------------------------------------------------------------------
# Use this in your API route functions to get a database session:
#
#   from app.core.database import get_db
#   from sqlalchemy.ext.asyncio import AsyncSession
#
#   @router.get("/documents")
#   async def list_documents(db: AsyncSession = Depends(get_db)):
#       result = await db.execute(select(Document))
#       return result.scalars().all()
#
# The session is automatically closed when the request finishes.

async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
