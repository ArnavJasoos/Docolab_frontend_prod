import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Assignment, Role, User, Folder, Document
from app.schemas.assignment import AssignmentCreate, AssignmentResponse, AssignmentListResponse, AssignmentListEntry
from app.services.auth_service import require_permission
from app.services.audit_service import record_audit, AuditAction

router = APIRouter()

VALID_SCOPES = ("folder", "document", "org")


async def _owner_role_id(db: AsyncSession, org_id):
    role = (
        await db.execute(select(Role).where(Role.org_id == org_id, Role.name == "owner"))
    ).scalars().first()
    return role.id if role else None


@router.post("", response_model=AssignmentResponse, status_code=status.HTTP_201_CREATED)
async def create_assignment(data: AssignmentCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if data.scope_type not in VALID_SCOPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid scope type")

    # Escalation guard (structural): to grant a role on a scope you must already
    # hold can_manage_members on that scope. For scope_type="org" this means you
    # must be an org admin — so org-admin can only be granted by an org admin.
    await require_permission(db, current_user.id, "can_manage_members", data.scope_type, data.scope_id)

    target_user = (await db.execute(select(User).where(User.id == data.user_id))).scalars().first()
    target_role = (await db.execute(select(Role).where(Role.id == data.role_id))).scalars().first()
    if not target_user or not target_role:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid user_id or role_id")

    # Validate the scope target exists (org scope must be the caller's own org).
    if data.scope_type == "folder":
        scope_exists = (await db.execute(select(Folder).where(Folder.id == data.scope_id))).scalars().first() is not None
    elif data.scope_type == "document":
        scope_exists = (await db.execute(select(Document).where(Document.id == data.scope_id))).scalars().first() is not None
    else:  # "org"
        scope_exists = str(data.scope_id) == str(current_user.org_id)
    if not scope_exists:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scope target not found")

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
        id=uuid.uuid4(), org_id=current_user.org_id, user_id=data.user_id,
        role_id=data.role_id, scope_type=data.scope_type, scope_id=data.scope_id,
    )
    db.add(new_assignment)
    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.ROLE_CHANGE, target_type="assignment", target_id=new_assignment.id,
        document_id=data.scope_id if data.scope_type == "document" else None,
        meta={"user_id": str(data.user_id), "role": target_role.name,
              "scope_type": data.scope_type, "scope_id": str(data.scope_id)},
    )
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
    entries = [
        AssignmentListEntry(id=a.id, user_id=a.user_id, role_id=a.role_id, role_name=r.name)
        for a, r in result.all()
    ]
    return {"assignments": entries}


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_assignment(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Revoke an assignment. Refuses to remove the LAST owner of a scope
    (which would orphan it / lock everyone out)."""
    assignment = (await db.execute(select(Assignment).where(Assignment.id == id))).scalars().first()
    if not assignment:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assignment not found")

    await require_permission(db, current_user.id, "can_manage_members", assignment.scope_type, assignment.scope_id)

    # Last-owner guard: don't allow removing the only owner of a scope.
    owner_role_id = await _owner_role_id(db, current_user.org_id)
    if owner_role_id is not None and assignment.role_id == owner_role_id:
        owners = (
            await db.execute(
                select(Assignment).where(
                    Assignment.scope_type == assignment.scope_type,
                    Assignment.scope_id == assignment.scope_id,
                    Assignment.role_id == owner_role_id,
                )
            )
        ).scalars().all()
        if len(owners) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot remove the last owner of this scope. Assign another owner first (or transfer ownership).",
            )

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.ROLE_REVOKE, target_type="assignment", target_id=assignment.id,
        document_id=assignment.scope_id if assignment.scope_type == "document" else None,
        meta={"user_id": str(assignment.user_id), "role_id": str(assignment.role_id),
              "scope_type": assignment.scope_type, "scope_id": str(assignment.scope_id)},
    )
    await db.delete(assignment)
    await db.commit()
