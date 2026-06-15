from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User
from app.schemas.auth import UserListResponse, UserListItem, UserUpdate, UserResponse

router = APIRouter()

@router.get("", response_model=UserListResponse)
async def list_users(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """List all users in the current user's organization"""
    users = (
        await db.execute(select(User).where(User.org_id == current_user.org_id))
    ).scalars().all()
    items = [
        UserListItem(
            id=u.id,
            email=u.email,
            display_name=u.display_name,
            avatar_color=u.avatar_color,
            status=u.status,
            created_at=u.created_at,
        )
        for u in users
    ]
    return {"users": items}

@router.get("/{id}", response_model=UserResponse)
async def get_user(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Get a single user by ID"""
    user = (
        await db.execute(select(User).where(User.id == id, User.org_id == current_user.org_id))
    ).scalars().first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user

@router.patch("/{id}", response_model=UserResponse)
async def update_user(
    id: str,
    data: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Update user profile (name, avatar color, status)"""
    user = (
        await db.execute(select(User).where(User.id == id, User.org_id == current_user.org_id))
    ).scalars().first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if data.display_name is not None:
        user.display_name = data.display_name
    if data.avatar_color is not None:
        user.avatar_color = data.avatar_color
    if data.status is not None:
        if data.status not in ["active", "disabled"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Status must be 'active' or 'disabled'"
            )
        user.status = data.status

    await db.commit()
    await db.refresh(user)
    return user
