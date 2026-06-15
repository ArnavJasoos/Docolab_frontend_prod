import uuid
from pydantic import BaseModel

class AssignmentCreate(BaseModel):
    user_id: str
    role_id: str
    scope_type: str
    scope_id: str

class AssignmentResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    role_id: uuid.UUID
    scope_type: str
    scope_id: uuid.UUID

    class Config:
        from_attributes = True

class AssignmentListEntry(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    role_id: uuid.UUID
    role_name: str

class AssignmentListResponse(BaseModel):
    assignments: list[AssignmentListEntry]
