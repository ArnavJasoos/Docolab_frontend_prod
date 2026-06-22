import uuid
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


# --- Requests ---------------------------------------------------------------

class ApprovalPolicyStepIn(BaseModel):
    step_no: int = Field(ge=1)
    required_role_id: uuid.UUID
    min_approvals: int = Field(default=1, ge=1)


class ApprovalPolicyCreate(BaseModel):
    name: str
    steps: list[ApprovalPolicyStepIn]


class ApprovalPolicyUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None
    steps: Optional[list[ApprovalPolicyStepIn]] = None  # if given, replaces all steps


class AttachPolicyRequest(BaseModel):
    policy_id: Optional[uuid.UUID] = None  # None = detach (revert to single owner gate)


# --- Responses --------------------------------------------------------------

class ApprovalPolicyStepOut(BaseModel):
    step_no: int
    required_role_id: uuid.UUID
    min_approvals: int

    model_config = ConfigDict(from_attributes=True)


class ApprovalPolicyOut(BaseModel):
    id: uuid.UUID
    name: str
    is_active: bool
    steps: list[ApprovalPolicyStepOut]

    model_config = ConfigDict(from_attributes=True)


class ApprovalPolicyListResponse(BaseModel):
    policies: list[ApprovalPolicyOut]


class AttachPolicyResponse(BaseModel):
    success: bool
    message: str
    approval_policy_id: Optional[uuid.UUID]


class ApprovalStepStatus(BaseModel):
    step_no: int
    required_role_id: uuid.UUID
    min_approvals: int
    approvals: int          # distinct approvers so far
    complete: bool


class ApprovalStatusResponse(BaseModel):
    single_gate: bool                       # True = no policy (one owner gate)
    policy_id: Optional[uuid.UUID] = None
    steps: list[ApprovalStepStatus] = []
    next_step: Optional[int] = None         # lowest incomplete step (None = done)
    complete: bool = False                  # chain fully satisfied
