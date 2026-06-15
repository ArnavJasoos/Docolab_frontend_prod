from pydantic import BaseModel
from typing import Optional

class FolderCreate(BaseModel):
    name: str
    parent_folder_id: Optional[str] = None

class FolderResponse(BaseModel):
    id: str
    name: str
    parent_folder_id: Optional[str]

    class Config:
        from_attributes = True