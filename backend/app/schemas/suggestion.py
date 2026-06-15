import uuid
from datetime import datetime
from typing import Optional, Literal

from pydantic import BaseModel, ConfigDict


# --- Requests ---------------------------------------------------------------

class SuggestionCreate(BaseModel):
    """Body for POST /documents/{id}/suggestions (shared by human and AI callers)."""
    type: Literal["insert", "delete", "replace", "format"]
    anchor: dict                      # Yjs relative position (JSONB)
    origin: Literal["human", "ai"] = "human"
    reason: Optional[str] = None      # AI rationale or author note


class SuggestionResolveRequest(BaseModel):
    """Body for accept / reject. `reason` is optional (recorded on the suggestion)."""
    reason: Optional[str] = None


# --- Responses --------------------------------------------------------------

class SuggestionOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    author_id: Optional[uuid.UUID]    # NULL = AI-authored
    origin: str
    type: str
    anchor: dict
    status: str                       # pending / approved / rejected / orphaned
    reason: Optional[str]
    resolved_by: Optional[uuid.UUID]
    resolved_at: Optional[datetime]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SuggestionListResponse(BaseModel):
    suggestions: list[SuggestionOut]


class SuggestionResolveResponse(BaseModel):
    success: bool
    message: str
    suggestion_id: uuid.UUID
    status: str
