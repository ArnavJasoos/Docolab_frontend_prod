import uuid
from datetime import datetime
from pydantic import BaseModel
from typing import Optional


class NotificationResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    document_id: uuid.UUID
    type: str
    payload: dict
    delivered: bool
    created_at: datetime
    read_at: Optional[datetime]

    class Config:
        from_attributes = True


class NotificationListResponse(BaseModel):
    notifications: list[NotificationResponse]


class MarkNotificationReadRequest(BaseModel):
    pass


class MarkNotificationReadResponse(BaseModel):
    success: bool
    message: str


class MarkAllNotificationsReadResponse(BaseModel):
    success: bool
    message: str
    count: int
