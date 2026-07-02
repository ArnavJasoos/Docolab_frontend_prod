import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


# --- Requests ---------------------------------------------------------------

class CommentCreate(BaseModel):
    """Body for POST /documents/{id}/comments."""
    body: str
    # Optional CLIENT-SUPPLIED id. The editor anchors comment marks inside the
    # (Yjs-owned) document text keyed by comment id, so the id must be stable
    # across client and backend — the client generates a UUID and sends it
    # here. Also makes retries idempotent (same id → same row). NULL = the
    # server generates one (backwards compatible).
    id: Optional[uuid.UUID] = None
    anchor: Optional[dict] = None              # NULL = comment on whole doc
    suggestion_id: Optional[uuid.UUID] = None  # link to a suggestion, if any
    parent_comment_id: Optional[uuid.UUID] = None  # threading (self-reference)


class CommentUpdate(BaseModel):
    """Body for PATCH /comments/{id} (edit the comment text)."""
    body: str


# --- Responses --------------------------------------------------------------

class CommentOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    suggestion_id: Optional[uuid.UUID]
    anchor: Optional[dict]
    author_id: uuid.UUID
    body: str
    is_resolved: bool
    parent_comment_id: Optional[uuid.UUID]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CommentResolve(BaseModel):
    """Body for PATCH /comments/:id/resolve"""
    is_resolved: bool


class CommentListResponse(BaseModel):
    comments: list[CommentOut]
