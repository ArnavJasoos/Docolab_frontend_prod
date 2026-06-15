import uuid
from datetime import datetime
from typing import Optional, Literal

from pydantic import BaseModel, ConfigDict


# --- Recommendation requests ------------------------------------------------

class RecommendationCreate(BaseModel):
    """Body for POST /versions/{id}/recommendations."""
    body: str
    anchor: dict                       # Yjs relative position (JSONB)


class RecommendationUpdate(BaseModel):
    """Body for PATCH /recommendations/{id} — status transitions only."""
    status: Literal["open", "addressed", "orphaned"]


# --- Recommendation responses (the append-only reply thread) ----------------

class RecommendationResponseCreate(BaseModel):
    """Body for POST /recommendations/{id}/responses (append-only)."""
    body: str


# --- Output models ----------------------------------------------------------

class RecommendationOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    version_id: uuid.UUID
    author_id: uuid.UUID
    anchor: dict
    body: str
    status: str                        # open / addressed / orphaned
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class RecommendationListResponse(BaseModel):
    recommendations: list[RecommendationOut]


class RecommendationResponseOut(BaseModel):
    id: uuid.UUID
    recommendation_id: uuid.UUID
    author_id: uuid.UUID
    body: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class RecommendationResponseListResponse(BaseModel):
    responses: list[RecommendationResponseOut]
