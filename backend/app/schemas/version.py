import uuid
from datetime import datetime
from pydantic import BaseModel
from typing import Optional


class VersionResponse(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    version_no: int
    kind: str  # submission / approved
    created_by: uuid.UUID
    created_at: datetime
    s3_key: str

    class Config:
        from_attributes = True


class VersionListResponse(BaseModel):
    versions: list[VersionResponse]


class VersionMetadataResponse(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    version_no: int
    kind: str
    created_by: uuid.UUID
    created_at: datetime
    s3_url: str  # Signed S3 URL
    # Frozen Slate document value captured at snapshot time (NULL on legacy
    # rows). This is what the frontend diffs/restores against.
    content: Optional[list] = None

    class Config:
        from_attributes = True


class SnapshotCreateRequest(BaseModel):
    """Body for POST /documents/{id}/versions — freeze the current content as
    a named version WITHOUT entering the approval flow (kind='snapshot')."""
    content: Optional[list] = None


class DiffResponse(BaseModel):
    from_version_no: int
    to_version_no: int
    diff_content: dict  # Diff data structure


class SubmitForApprovalRequest(BaseModel):
    # Optional frozen Slate value of the document at submit time. The editor
    # sends its live (Yjs-canonical) content so the submission is diffable.
    content: Optional[list] = None


class SubmitForApprovalResponse(BaseModel):
    version_id: str
    version_no: int
    message: str


class ApprovalRequest(BaseModel):
    pass


class ApprovalResponse(BaseModel):
    success: bool
    message: str


class RejectRequest(BaseModel):
    pass


class RejectResponse(BaseModel):
    success: bool
    message: str


class RestoreRequest(BaseModel):
    section_id: str


class RestoreResponse(BaseModel):
    success: bool
    message: str
