import uuid
from datetime import datetime
from pydantic import BaseModel
from typing import Optional

class FolderCreate(BaseModel):
    name: str
    parent_folder_id: Optional[str] = None

class FolderUpdate(BaseModel):
    name: Optional[str] = None
    parent_folder_id: Optional[str] = None

class FolderResponse(BaseModel):
    id: uuid.UUID
    name: str
    parent_folder_id: Optional[uuid.UUID]
    created_by: uuid.UUID

    class Config:
        from_attributes = True

class FolderTreeItem(BaseModel):
    id: uuid.UUID
    name: str
    parent_folder_id: Optional[uuid.UUID]
    created_by: uuid.UUID
    created_at: datetime

    class Config:
        from_attributes = True

class FolderListResponse(BaseModel):
    folders: list[FolderTreeItem]
