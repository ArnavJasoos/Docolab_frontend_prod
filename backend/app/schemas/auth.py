import uuid
from datetime import datetime
from pydantic import BaseModel, EmailStr
from typing import Optional

class UserBase(BaseModel):
    email: EmailStr
    display_name: str

class UserCreate(UserBase):
    password: str

class UserUpdate(BaseModel):
    display_name: Optional[str] = None
    avatar_color: Optional[str] = None
    status: Optional[str] = None

class UserResponse(UserBase):
    id: uuid.UUID
    avatar_color: Optional[str]
    status: str
    created_at: datetime

    class Config:
        from_attributes = True

class UserListItem(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    avatar_color: Optional[str]
    status: str
    created_at: datetime

    class Config:
        from_attributes = True

class UserListResponse(BaseModel):
    users: list[UserListItem]

class Token(BaseModel):
    user: UserResponse
    token: str                  # short-lived JWT access token
    refresh_token: str          # long-lived opaque refresh token (rotated)

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class RefreshRequest(BaseModel):
    refresh_token: str

class RefreshResponse(BaseModel):
    token: str                  # new access token
    refresh_token: str          # new refresh token (rotation: the old one is now revoked)
    token_type: str = "bearer"

class LogoutRequest(BaseModel):
    refresh_token: str

class LogoutResponse(BaseModel):
    success: bool
    message: str