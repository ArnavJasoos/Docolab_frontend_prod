import uuid
from typing import Literal

from pydantic import BaseModel


class TransferOwnershipRequest(BaseModel):
    """Body for POST /documents/{id}/transfer-ownership."""
    to_user_id: uuid.UUID
    # What role the current owner is demoted to (at the document scope) once
    # ownership moves. Must be a role that exists in the org.
    demote_to: Literal["approver", "editor", "viewer"] = "editor"


class TransferOwnershipResponse(BaseModel):
    success: bool
    message: str
    document_id: uuid.UUID
    new_owner_id: uuid.UUID
    previous_owner_id: uuid.UUID
    previous_owner_role: str
    demoted_to: str
