import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class AuditEntryOut(BaseModel):
    """One audit_log row.

    Note: the ORM attribute for the JSONB column is `meta` (the DB column is
    literally named "metadata", which is reserved by SQLAlchemy). The audit
    router builds these dicts explicitly and exposes the field as `metadata`
    in the JSON contract.
    """
    id: uuid.UUID
    actor_id: uuid.UUID
    document_id: Optional[uuid.UUID]
    action: str
    target_type: str
    target_id: Optional[uuid.UUID]
    metadata: Optional[dict]
    created_at: datetime


class AuditListResponse(BaseModel):
    entries: list[AuditEntryOut]
