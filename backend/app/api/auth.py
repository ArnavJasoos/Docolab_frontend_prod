from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_password_hash, verify_password, create_access_token
from app.models.database_models import User, Role, Assignment
from app.schemas.auth import (
    UserCreate, Token, LoginRequest, UserResponse,
    RefreshRequest, RefreshResponse, LogoutRequest, LogoutResponse,
)
from app.api.deps import get_current_user
from app.services.audit_service import record_audit, AuditAction
from app.services.token_service import (
    issue_refresh_token, rotate_refresh_token, revoke_refresh_token, prune_user_tokens,
)

router = APIRouter()


@router.post("/signup", response_model=Token, status_code=status.HTTP_201_CREATED)
async def signup(data: UserCreate, db: AsyncSession = Depends(get_db)):
    # Normalise email to lowercase: the DB enforces case-insensitive uniqueness
    # (unique index on lower(email)), so the duplicate check must match that or a
    # different-case dupe slips past this 409 and dies on the index (500).
    email = data.email.strip().lower()
    existing_user = (
        await db.execute(select(User).where(func.lower(User.email) == email))
    ).scalars().first()
    if existing_user:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    hashed_password = get_password_hash(data.password)

    # v1: every user joins the single shared org (org = team/tenant), not a new
    # org per user. Roles are granted via assignments (creator-owns on create).
    user = User(
        org_id=settings.DEFAULT_ORG_ID,
        email=email,
        password_hash=hashed_password,
        display_name=data.display_name,
        avatar_color="#7aa2f7",
        status="active",
    )
    db.add(user)
    await db.flush()

    # v1: every new user lands in the shared org with edit rights so they can
    # create root documents immediately (no org/folder setup required). RBAC is
    # preserved — this is an org-scoped `editor` assignment, not a bypass.
    editor_role = (
        await db.execute(
            select(Role).where(Role.org_id == user.org_id, Role.name == "editor")
        )
    ).scalars().first()
    if editor_role:
        db.add(Assignment(
            org_id=user.org_id,
            user_id=user.id,
            role_id=editor_role.id,
            scope_type="org",
            scope_id=user.org_id,
        ))

    record_audit(
        db, org_id=user.org_id, actor_id=user.id,
        action=AuditAction.USER_SIGNUP, target_type="user", target_id=user.id,
        meta={"email": user.email},
    )
    token = create_access_token(subject=user.id)
    refresh_token = issue_refresh_token(db, user)   # queued; committed below
    await db.commit()
    await db.refresh(user)
    return {"user": user, "token": token, "refresh_token": refresh_token}


@router.post("/login", response_model=Token)
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    # Case-insensitive match (mirrors the lower(email) unique index), so a user
    # can log in regardless of how they cased their email at signup.
    email = data.email.strip().lower()
    user = (
        await db.execute(select(User).where(func.lower(User.email) == email))
    ).scalars().first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")

    if user.status == "disabled":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user account")

    token = create_access_token(subject=user.id)
    refresh_token = issue_refresh_token(db, user)
    await prune_user_tokens(db, user.id)   # keep this user's token rows bounded
    record_audit(
        db, org_id=user.org_id, actor_id=user.id,
        action=AuditAction.LOGIN, target_type="user", target_id=user.id,
    )
    await db.commit()
    await db.refresh(user)
    return {"user": user, "token": token, "refresh_token": refresh_token}


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.post("/refresh", response_model=RefreshResponse)
async def refresh_token(data: RefreshRequest, db: AsyncSession = Depends(get_db)):
    """Exchange a valid refresh token for a NEW access token + a NEW refresh
    token (rotation). The presented refresh token is revoked; reusing an
    already-revoked token revokes the whole family (theft mitigation)."""
    user, new_refresh = await rotate_refresh_token(db, data.refresh_token)
    new_access = create_access_token(subject=user.id)
    record_audit(
        db, org_id=user.org_id, actor_id=user.id,
        action=AuditAction.TOKEN_REFRESH, target_type="user", target_id=user.id,
    )
    await db.commit()
    return {"token": new_access, "refresh_token": new_refresh, "token_type": "bearer"}


@router.post("/logout", response_model=LogoutResponse)
async def logout(data: LogoutRequest, db: AsyncSession = Depends(get_db)):
    """Revoke the supplied refresh token (real server-side logout). Idempotent —
    an unknown/already-revoked token still returns success so clients can always
    clear their state."""
    revoked = await revoke_refresh_token(db, data.refresh_token)
    await db.commit()
    msg = "Logged out" if revoked else "Already logged out"
    return {"success": True, "message": msg}
