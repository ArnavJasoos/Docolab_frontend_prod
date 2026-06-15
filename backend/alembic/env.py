# =============================================================================
# alembic/env.py — wired to read DATABASE_URL from the environment and to
# use our SQLAlchemy models for autogenerate support.
# =============================================================================

import asyncio
import os
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

from dotenv import load_dotenv
load_dotenv()  # loads backend/.env into os.environ

# ---------------------------------------------------------------------------
# Make sure `app/` is importable when running alembic from backend/
# ---------------------------------------------------------------------------
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Import our models so Alembic knows about all tables (autogenerate support).
from app.core.database import Base          # noqa: E402
import app.models.database_models           # noqa: E402, F401  (registers all models)

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# This is what enables `alembic revision --autogenerate` to diff your models
# against the live DB and generate the migration for you automatically.
target_metadata = Base.metadata


# ---------------------------------------------------------------------------
# Resolve DATABASE_URL from environment (never from alembic.ini)
# ---------------------------------------------------------------------------
def _get_url() -> str:
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        host     = os.environ.get("PGHOST",     "localhost")
        port     = os.environ.get("PGPORT",     "5432")
        user     = os.environ.get("PGUSER",     "postgres")
        password = os.environ.get("PGPASSWORD", "postgres")
        dbname   = os.environ.get("PGDATABASE", "docplatform")
        url = f"postgresql+asyncpg://{user}:{password}@{host}:{port}/{dbname}"

    # Ensure asyncpg driver prefix for SQLAlchemy async engine
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    elif url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+asyncpg://", 1)
    return url


config.set_main_option("sqlalchemy.url", _get_url())


# ---------------------------------------------------------------------------
# Offline mode (generates SQL without connecting to DB)
# ---------------------------------------------------------------------------
def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


# ---------------------------------------------------------------------------
# Online mode (connects to DB and runs migrations)
# ---------------------------------------------------------------------------
def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
