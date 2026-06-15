import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Assignment, AuditLog, Role, User, Folder, Document
from app.schemas.assignment import AssignmentCreate, AssignmentResponse, AssignmentListResponse, AssignmentListEntry
from app.services.auth_service import authorize

router = APIRouter()

@router.post("", response_model=AssignmentResponse, status_code=status.HTTP_201_CREATED)
async def create_assignment(data: AssignmentCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    allowed, _, _ = await authorize(db, current_user.id, "can_manage_members", data.scope_type, data.scope_id)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Lacks 'can_manage_members' on this scope"
        )

    target_user = (await db.execute(select(User).where(User.id == data.user_id))).scalars().first()
    target_role = (await db.execute(select(Role).where(Role.id == data.role_id))).scalars().first()
    if not target_user or not target_role:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid user_id or role_id")

    if data.scope_type == "folder":
        scope_exists = (await db.execute(select(Folder).where(Folder.id == data.scope_id))).scalars().first() is not None
    elif data.scope_type == "document":
        scope_exists = (await db.execute(select(Document).where(Document.id == data.scope_id))).scalars().first() is not None
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid scope type")

    if not scope_exists:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scope target ID not found")

    dup = (
        await db.execute(
            select(Assignment).where(
                Assignment.user_id == data.user_id,
                Assignment.scope_type == data.scope_type,
                Assignment.scope_id == data.scope_id,
            )
        )
    ).scalars().first()
    if dup:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Assignment already exists")

    new_assignment = Assignment(
        id=uuid.uuid4(),
        org_id=current_user.org_id,
        user_id=data.user_id,
        role_id=data.role_id,
        scope_type=data.scope_type,
        scope_id=data.scope_id
    )

    audit_entry = AuditLog(
        org_id=current_user.org_id,
        actor_id=current_user.id,
        action="role_change",
        target_type="assignment",
        target_id=new_assignment.id,
        meta={
            "user_id": data.user_id,
            "role_id": data.role_id,
            "scope_type": data.scope_type,
            "scope_id": data.scope_id,
        },
    )

    db.add(new_assignment)
    db.add(audit_entry)
    await db.commit()
    await db.refresh(new_assignment)

    return new_assignment

@router.get("", response_model=AssignmentListResponse)
async def list_assignments(scope_type: str, scope_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = await db.execute(
        select(Assignment, Role)
        .join(Role, Role.id == Assignment.role_id)
        .where(Assignment.scope_type == scope_type, Assignment.scope_id == scope_id)
    )

    entries = []
    for ass, role in result.all():
        entries.append(
            AssignmentListEntry(
                id=ass.id,
                user_id=ass.user_id,
                role_id=ass.role_id,
                role_name=role.name
            )
        )
    return {"assignments": entries}

@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_assignment(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Revoke an assignment"""
    assignment = (await db.execute(select(Assignment).where(Assignment.id == id))).scalars().first()
    if not assignment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found")

    allowed, _, _ = await authorize(db, current_user.id, "can_manage_members", assignment.scope_type, assignment.scope_id)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Lacks 'can_manage_members' on this scope"
        )

    audit_entry = AuditLog(
        org_id=current_user.org_id,
        actor_id=current_user.id,
        action="role_revoke",
        target_type="assignment",
        target_id=assignment.id,
        meta={
            "user_id": str(assignment.user_id),
            "role_id": str(assignment.role_id),
            "scope_type": assignment.scope_type,
            "scope_id": str(assignment.scope_id),
        },
    )

    db.add(audit_entry)
    await db.delete(assignment)
    await db.commit()
