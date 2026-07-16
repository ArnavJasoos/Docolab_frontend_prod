# =============================================================================
# app/services/ai_model_service.py
# The single place that reasons about the org AI-model catalog (ai_models).
#
# users.ai_model stores a model_key; this service resolves that key against the
# ENABLED catalog and, crucially, falls back to the org default when the key is
# missing or has been disabled — so an admin disabling a model, or a stale
# value, can never hard-fail AI in the editor.
#
# The catalog is DERIVED from the Ask-AI router's config.yaml: a model_key here
# is the router's own 'provider:model_key' identifier (e.g. 'groq:llama_70b'),
# so anything an admin can assign is by construction something the router can
# call. config.yaml decides what EXISTS; this table decides, per org, what is
# ENABLED and which model is the default.
#
# Vendor API keys live only in backend/.env (expanded into config.yaml at load
# time) — this layer governs *which* model is permitted, not *how* to call it.
# =============================================================================

from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.database_models import AiModel
from app.services.ask_ai.model_registry import ModelRegistry


def seed_catalog() -> list[dict]:
    """The rows a fresh org's catalog starts with: every model configured in the
    Ask-AI router, all enabled, with the router's own default_model flagged as
    the org default."""
    default_model_id = ModelRegistry.default_model()
    return [
        {
            "vendor": entry["vendor"],
            "model_key": entry["model_id"],
            "display_name": entry["display_name"],
            "enabled": True,
            "is_default": entry["model_id"] == default_model_id,
        }
        for entry in ModelRegistry.list_catalog()
    ]


async def list_models(db: AsyncSession, org_id, only_enabled: bool = False) -> list[AiModel]:
    query = select(AiModel).where(AiModel.org_id == org_id)
    if only_enabled:
        query = query.where(AiModel.enabled == True)  # noqa: E712
    return list((await db.execute(query.order_by(AiModel.display_name))).scalars().all())


async def get_by_key(db: AsyncSession, org_id, model_key: str) -> Optional[AiModel]:
    return (
        await db.execute(
            select(AiModel).where(AiModel.org_id == org_id, AiModel.model_key == model_key)
        )
    ).scalars().first()


async def default_model(db: AsyncSession, org_id) -> Optional[AiModel]:
    """The org's default (fallback) model — the flagged default if enabled, else
    the first enabled model, else None."""
    flagged = (
        await db.execute(
            select(AiModel).where(
                AiModel.org_id == org_id, AiModel.is_default == True, AiModel.enabled == True  # noqa: E712
            )
        )
    ).scalars().first()
    if flagged:
        return flagged
    return (
        await db.execute(
            select(AiModel).where(AiModel.org_id == org_id, AiModel.enabled == True)  # noqa: E712
            .order_by(AiModel.created_at)
        )
    ).scalars().first()


async def resolve(db: AsyncSession, org_id, model_key: str) -> Optional[AiModel]:
    """Resolve a document's model_key to a usable, ENABLED catalog row. Falls
    back to the org default when the key is unknown or disabled. Returns None
    only if the org has no enabled models at all."""
    m = await get_by_key(db, org_id, model_key)
    if m and m.enabled:
        return m
    return await default_model(db, org_id)


async def seed_org_catalog(db: AsyncSession, org_id) -> None:
    """Reconcile an org's catalog with the router's config.yaml, idempotently.

    Models newly added to config.yaml are inserted; rows the admin already has
    are left untouched, so their enabled/is_default choices survive a restart.
    Rows whose model_key no longer exists in config.yaml are NOT deleted here —
    resolve() already falls back for them, and dropping a row would silently
    discard an admin's assignment. Queued on the given session; caller commits.
    """
    rows = seed_catalog()
    existing_keys = set((
        await db.execute(select(AiModel.model_key).where(AiModel.org_id == org_id))
    ).scalars().all())

    # Only claim the default flag on a fresh catalog — never override an admin's
    # later choice of default.
    fresh = not existing_keys
    for row in rows:
        if row["model_key"] in existing_keys:
            continue
        db.add(AiModel(org_id=org_id, **{**row, "is_default": row["is_default"] and fresh}))
