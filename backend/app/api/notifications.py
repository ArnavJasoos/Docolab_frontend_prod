from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User, Notification
from app.schemas.notification import (
    NotificationListResponse, MarkNotificationReadRequest,
    MarkNotificationReadResponse, MarkAllNotificationsReadResponse
)

router = APIRouter()


@router.get("", response_model=NotificationListResponse)
async def get_notifications(
    unread: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Fetch pending notifications (catch-up popup)."""
    query = select(Notification).where(
        Notification.user_id == current_user.id,
        Notification.org_id == current_user.org_id
    )
    if unread:
        query = query.where(Notification.read_at == None)  # noqa: E711

    query = query.order_by(Notification.created_at.desc())
    notifications = (await db.execute(query)).scalars().all()

    return {"notifications": notifications}


@router.post("/{id}/read", response_model=MarkNotificationReadResponse)
async def mark_notification_read(
    id: str,
    data: MarkNotificationReadRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Mark a notification as read."""
    notification = (
        await db.execute(
            select(Notification).where(
                Notification.id == id,
                Notification.user_id == current_user.id,
                Notification.org_id == current_user.org_id
            )
        )
    ).scalars().first()

    if not notification:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")

    notification.read_at = datetime.utcnow()
    await db.commit()

    return {"success": True, "message": "Notification marked as read"}


@router.post("/read-all", response_model=MarkAllNotificationsReadResponse)
async def mark_all_notifications_read(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Bulk mark all notifications as read."""
    notifications = (
        await db.execute(
            select(Notification).where(
                Notification.user_id == current_user.id,
                Notification.org_id == current_user.org_id,
                Notification.read_at == None  # noqa: E711
            )
        )
    ).scalars().all()

    count = len(notifications)
    now = datetime.utcnow()
    for notification in notifications:
        notification.read_at = now

    await db.commit()

    return {"success": True, "message": "All notifications marked as read", "count": count}
