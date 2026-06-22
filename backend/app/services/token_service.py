# =============================================================================
# app/services/token_service.py
# Server-side refresh-token store: real, revocable sessions on top of the
# stateless JWT access token.
#
# WHY: the access token (JWT) is short-ish and cannot be revoked once issued.
# A refresh token is a long-lived, OPAQUE secret the client exchanges for a new
# access token. Because it lives in the DB we can rotate it, revoke it on
# logout, and detect theft (reuse of an already-rotated token).
#
# SECURITY:
#   - Only the SHA-256 HASH of the token is stored, never the raw value, so a
#     DB dump can't be replayed.
#   - Rotation: every /auth/refresh revokes the presented token and mints a new
#     one. Presenting an already-revoked token (reuse) revokes the user's whole
#     token family — the classic refresh-token-theft mitigation.
# =============================================================================

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.database_models import RefreshToken, User

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Invalid or expired refresh token",
    headers={"WWW-Authenticate": "Bearer"},
)


def hash_token(raw: str) -> str:
    """One-way hash; only this is stored / compared (never the raw token)."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _new_raw() -> str:
    """A high-entropy, URL-safe opaque token (no PII, not a JWT)."""
    return secrets.token_urlsafe(48)


def issue_refresh_token(db: AsyncSession, user: User) -> str:
    """Queue a new refresh-token row for `user` and return the RAW token.

    db.add() only — the caller's commit persists it alongside whatever else the
    request is doing (login/signup/refresh), keeping it atomic.
    """
    raw = _new_raw()
    db.add(RefreshToken(
        org_id=user.org_id,
        user_id=user.id,
        token_hash=hash_token(raw),
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    ))
    return raw


async def _revoke_family(db: AsyncSession, user_id) -> None:
    """Revoke every live refresh token for a user (logout-everywhere / theft)."""
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked == False)  # noqa: E712
        .values(revoked=True)
    )


async def rotate_refresh_token(db: AsyncSession, raw: str) -> tuple[User, str]:
    """Validate a refresh token and rotate it.

    Returns (user, new_raw_refresh_token). Raises 401 if the token is unknown,
    expired, or revoked. Reuse of a revoked token revokes the whole family.
    The caller commits.
    """
    row = (
        await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw)))
    ).scalars().first()
    if row is None:
        raise _UNAUTHORIZED

    # Reuse of an already-revoked token => likely theft: kill the whole family.
    # Commit the revocation explicitly — we raise 401 below, and the request's
    # session would otherwise roll the revoke back on the exception.
    if row.revoked:
        await _revoke_family(db, row.user_id)
        await db.commit()
        raise _UNAUTHORIZED

    if row.expires_at <= datetime.now(timezone.utc):
        raise _UNAUTHORIZED

    user = (await db.execute(select(User).where(User.id == row.user_id))).scalars().first()
    if user is None or user.status == "disabled":
        raise _UNAUTHORIZED

    # Rotate: revoke the presented token, mint a fresh one.
    row.revoked = True
    new_raw = issue_refresh_token(db, user)
    return user, new_raw


async def revoke_refresh_token(db: AsyncSession, raw: str) -> bool:
    """Revoke a single refresh token (logout). Idempotent; returns True if a
    live token was found and revoked. The caller commits."""
    row = (
        await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw)))
    ).scalars().first()
    if row is None or row.revoked:
        return False
    row.revoked = True
    return True
