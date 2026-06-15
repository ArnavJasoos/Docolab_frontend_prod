import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


# --- Requests ---------------------------------------------------------------

class CommentCreate(BaseModel):
    """Body for POST /documents/{id}/comments."""
    body: str
    anchor: Optional[dict] = None              # NULL = comment on whole doc
    suggestion_id: Optional[uuid.UUID] = None  # link to a suggestion, if any
    parent_comment_id: Optional[uuid.UUID] = None  # threading (self-reference)


# --- Responses --------------------------------------------------------------

class CommentOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    suggestion_id: Optional[uuid.UUID]
    anchor: Optional[dict]
    author_id: uuid.UUID
    body: str
    parent_comment_id: Optional[uuid.UUID]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CommentListResponse(BaseModel):
    comments: list[CommentOut]
