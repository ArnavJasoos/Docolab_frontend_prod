import jwt
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
    await db.commit()
    await db.refresh(user)

    token = create_access_token(subject=user.id)
    return {"user": user, "token": token}

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
    return {"user": user, "token": token}

@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user

@router.post("/refresh", response_model=RefreshResponse)
def refresh_token(data: RefreshRequest):
    """DUMMY (JWT-only stub): mint a fresh access token from a supplied token.

    The v1 18-table schema has no refresh-token store, so this validates the
    supplied JWT's signature + subject and issues a new access token. Swap in a
    real refresh-token store (persist/rotate/revoke) when one is added. No DB
    access, so this stays a plain sync handler.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired refresh token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(data.refresh_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except jwt.PyJWTError:
        raise credentials_exception

    new_token = create_access_token(subject=user_id)
    return {"token": new_token, "token_type": "bearer"}

@router.post("/logout", response_model=LogoutResponse)
def logout(data: LogoutRequest):
    """DUMMY (JWT-only stub): no server-side refresh-token store exists in v1,
    so logout just acknowledges; the client discards its stored tokens. Becomes
    a real revoke once a refresh-token store is introduced."""
    return {"success": True, "message": "Logged out"}
