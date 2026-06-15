import json
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Assignment, AuditLog, Role, User, Folder, Document
from app.schemas.assignment import AssignmentCreate, AssignmentResponse, AssignmentListResponse, AssignmentListEntry
from app.services.auth_service import authorize

router = APIRouter()

@router.post("", response_model=AssignmentResponse, status_code=status.HTTP_201_CREATED)
def create_assignment(data: AssignmentCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    allowed, _, _ = authorize(db, current_user.id, "can_manage_members", data.scope_type, data.scope_id)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, 
            detail="Forbidden: Lacks 'can_manage_members' on this scope"
        )

    target_user = db.query(User).filter(User.id == data.user_id).first()
    target_role = db.query(Role).filter(Role.id == data.role_id).first()
    if not target_user or not target_role:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid user_id or role_id")

    if data.scope_type == "folder":
        scope_exists = db.query(Folder).filter(Folder.id == data.scope_id).first() is not None
    elif data.scope_type == "document":
        scope_exists = db.query(Document).filter(Document.id == data.scope_id).first() is not None
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid scope type")

    if not scope_exists:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scope target ID not found")

    dup = db.query(Assignment).filter(
        Assignment.user_id == data.user_id,
        Assignment.scope_type == data.scope_type,
        Assignment.scope_id == data.scope_id
    ).first()
    if dup:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Assignment already exists")

    new_assignment = Assignment(
        id=str(uuid.uuid4()),
        org_id=current_user.org_id,
        user_id=data.user_id,
        role_id=data.role_id,
        scope_type=data.scope_type,
        scope_id=data.scope_id
    )
    
    audit_meta = {
        "user_id": data.user_id,
        "role_id": data.role_id,
        "scope_type": data.scope_type,
        "scope_id": data.scope_id
    }
    
    audit_entry = AuditLog(
        action="role_change",
        actor_id=current_user.id,
        target_type="assignment",
        target_id=new_assignment.id,
        metadata_json=json.dumps(audit_meta)
    )

    db.add(new_assignment)
    db.add(audit_entry)
    db.commit()
    db.refresh(new_assignment)
    
    return new_assignment

@router.get("", response_model=AssignmentListResponse)
def list_assignments(scope_type: str, scope_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    results = db.query(Assignment, Role).join(Role, Role.id == Assignment.role_id).filter(
        Assignment.scope_type == scope_type,
        Assignment.scope_id == scope_id
    ).all()
    
    entries = []
    for ass, role in results:
        entries.append(
            AssignmentListEntry(
                id=ass.id,
                user_id=ass.user_id,
                role_id=ass.role_id,
                role_name=role.name
            )
        )
    return {"assignments": entries}