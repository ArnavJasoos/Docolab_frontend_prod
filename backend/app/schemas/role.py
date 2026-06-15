from pydantic import BaseModel
from typing import List

class RoleResponse(BaseModel):
    id: str
    name: str
    permissions: List[str]

    class Config:
        from_attributes = True

class RoleListResponse(BaseModel):
    roles: List[RoleResponse]