from pydantic import BaseModel

class AssignmentCreate(BaseModel):
    user_id: str
    role_id: str
    scope_type: str
    scope_id: str

class AssignmentResponse(BaseModel):
    id: str
    user_id: str
    role_id: str
    scope_type: str
    scope_id: str

    class Config:
        from_attributes = True

class AssignmentListEntry(BaseModel):
    id: str
    user_id: str
    role_id: str
    role_name: str

class AssignmentListResponse(BaseModel):
    assignments: list[AssignmentListEntry]