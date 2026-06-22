from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User
from app.schemas.auth import UserListResponse, UserListItem, UserUpdate, UserResponse
from app.services.audit_service import record_audit, AuditAction
from app.services.auth_service import is_org_admin

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
    """Update user profile (name, avatar color, status).

    RBAC: a user may edit their OWN profile; editing another user (incl.
    disabling via status) requires being an ORG ADMIN (an org-scoped role with
    can_manage_members). Org-admin is an explicit org-scoped grant — it is NOT
    inferred from folder/document ownership (see auth_service.is_org_admin).
    """
    user = (
        await db.execute(select(User).where(User.id == id, User.org_id == current_user.org_id))
    ).scalars().first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    is_self = str(user.id) == str(current_user.id)
    if not is_self and not await is_org_admin(db, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the user themselves or an org admin may edit this profile",
        )

    before, after = {}, {}
    if data.display_name is not None:
        before["display_name"] = user.display_name; after["display_name"] = data.display_name
        user.display_name = data.display_name
    if data.avatar_color is not None:
        before["avatar_color"] = user.avatar_color; after["avatar_color"] = data.avatar_color
        user.avatar_color = data.avatar_color
    if data.status is not None:
        if data.status not in ["active", "disabled"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Status must be 'active' or 'disabled'"
            )
        before["status"] = user.status; after["status"] = data.status
        user.status = data.status

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.USER_UPDATE, target_type="user",
        target_id=user.id, meta={"target_user": str(user.id), "before": before, "after": after},
    )
    await db.commit()
    await db.refresh(user)
    return user
