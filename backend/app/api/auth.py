from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_password_hash, verify_password, create_access_token
from app.models.database_models import User
from app.schemas.auth import (
    UserCreate, Token, LoginRequest, UserResponse,
    RefreshRequest, RefreshResponse, LogoutRequest, LogoutResponse,
)
from app.api.deps import get_current_user
from app.services.audit_service import record_audit, AuditAction
from app.services.token_service import (
    issue_refresh_token, rotate_refresh_token, revoke_refresh_token,
)

router = APIRouter()


@router.post("/signup", response_model=Token, status_code=status.HTTP_201_CREATED)
async def signup(data: UserCreate, db: AsyncSession = Depends(get_db)):
    existing_user = (
        await db.execute(select(User).where(User.email == data.email))
    ).scalars().first()
    if existing_user:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    hashed_password = get_password_hash(data.password)

    # v1: every user joins the single shared org (org = team/tenant), not a new
    # org per user. Roles are granted via assignments (creator-owns on create).
    user = User(
        org_id=settings.DEFAULT_ORG_ID,
        email=data.email,
        password_hash=hashed_password,
        display_name=data.display_name,
        avatar_color="#7aa2f7",
        status="active",
    )
    db.add(user)
    await db.flush()
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
    user = (
        await db.execute(select(User).where(User.email == data.email))
    ).scalars().first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")

    if user.status == "disabled":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user account")

    token = create_access_token(subject=user.id)
    refresh_token = issue_refresh_token(db, user)
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
