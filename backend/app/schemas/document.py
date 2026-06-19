import uuid
from datetime import datetime
from pydantic import BaseModel
from typing import Optional

class DocumentCreate(BaseModel):
    folder_id: Optional[uuid.UUID] = None
    title: str

class DocumentUpdate(BaseModel):
    title: Optional[str] = None
    folder_id: Optional[uuid.UUID] = None
    # NOTE: no `starred` here — bookmarks are personal; use PUT/DELETE
    # /documents/{id}/star instead. `trashed` is the reversible recycle bin.
    trashed: Optional[bool] = None

class DocumentResponse(BaseModel):
    id: uuid.UUID
    folder_id: uuid.UUID
    title: str
    status: str
    current_version_no: int
    yjs_doc_key: str
    starred: bool
    trashed: bool
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class DocumentListItem(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    current_version_no: int
    starred: bool
    trashed: bool
    created_by: uuid.UUID

    class Config:
        from_attributes = True

class DocumentListResponse(BaseModel):
    documents: list[DocumentListItem]

class AuthorizeCheckResponse(BaseModel):
    allowed: bool
    resolved_role: str | None
    via_scope: str | None

class StarResponse(BaseModel):
    document_id: uuid.UUID
    starred: bool               # this user's personal bookmark state after the call
