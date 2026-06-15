# =============================================================================
# app/api/ownership.py  —  POST /documents/{id}/transfer-ownership
#
# WHY THIS ENDPOINT EXISTS (the problem it solves)
# -------------------------------------------------------------------------
# In this system "owner" is NOT a column on the document — it is an
# `assignments` row saying "user X holds the owner role on scope Y", and
# authorize() resolves a user's role by walking document -> folder -> parent
# folders and taking the first assignment it finds.
#
# That makes "transfer ownership" awkward with only the base assignment
# endpoints (POST /assignments + DELETE /assignments/{id}):
#   * It takes 2+ separate calls (grant new owner, then revoke/downgrade the
#     old one) -> NOT atomic. If the second call fails you can end up with two
#     owners, or — if done in the wrong order — with NO owner (the caller can
#     delete their own owner row and lock everyone out).
#   * There is no PATCH on assignments, so "change a role" means delete + add,
#     which trips the UNIQUE(user_id, scope_type, scope_id) constraint if done
#     in the wrong order.
#   * Inherited ownership (owner of the parent folder, not the document) is
#     easy to get wrong.
#
# Real scenario: a manager asks a junior to create a document. The junior
# becomes its owner. When the manager joins, they should be able to take over
# ownership cleanly.
#
# This endpoint does the whole hand-off in ONE transaction, in the safe order
# (grant the new owner FIRST, then demote the previous owner), and writes a
# single audit_log row. It changes nothing structural: no schema change, no new
# table — it only writes `assignments` rows, exactly the model the design
# already uses.
#
# SCOPE SEMANTICS: the transfer is applied at the DOCUMENT scope. The new owner
# gets a document-scoped owner assignment; the caller gets a document-scoped
# `demote_to` assignment which OVERRIDES any ownership they inherited from a
# parent folder *for this document only* (authorize checks the document scope
# before the folder). Folder-level ownership is intentionally left untouched.
# =============================================================================

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User, Document, Assignment, Role, AuditLog
from app.schemas.ownership import TransferOwnershipRequest, TransferOwnershipResponse
from app.services.auth_service import authorize

router = APIRouter()


async def _role_by_name(db: AsyncSession, org_id, name: str) -> Role | None:
    return (
        await db.execute(select(Role).where(Role.org_id == org_id, Role.name == name))
    ).scalars().first()


async def _doc_scoped_assignment(db: AsyncSession, user_id, doc_id) -> Assignment | None:
    return (
        await db.execute(
            select(Assignment).where(
                Assignment.user_id == user_id,
                Assignment.scope_type == "document",
                Assignment.scope_id == doc_id,
            )
        )
    ).scalars().first()


@router.post(
    "/documents/{id}/transfer-ownership",
    response_model=TransferOwnershipResponse,
)
async def transfer_ownership(
    id: str,
    data: TransferOwnershipRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Atomically transfer document ownership to another user in the same org."""
    # 1. Document must exist within the caller's org.
    doc = (
        await db.execute(
            select(Document).where(Document.id == id, Document.org_id == current_user.org_id)
        )
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # 2. Only someone who can manage members on this scope may transfer ownership
    #    (the owner role holds can_manage_members).
    has_perm, caller_role, _ = await authorize(
        db, current_user.id, "can_manage_members", "document", doc.id
    )
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to transfer ownership (can_manage_members)",
        )

    # 3. Cannot transfer to yourself.
    if str(data.to_user_id) == str(current_user.id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You already own this document",
        )

    # 4. Target user must exist in the same org.
    target = (
        await db.execute(
            select(User).where(
                User.id == data.to_user_id, User.org_id == current_user.org_id
            )
        )
    ).scalars().first()
    if not target:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Target user not found in your organization",
        )

    # 5. Resolve the org's owner + demote roles (they must be seeded for the org).
    owner_role = await _role_by_name(db, current_user.org_id, "owner")
    if not owner_role:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The 'owner' role is not configured for this organization",
        )
    demote_role = await _role_by_name(db, current_user.org_id, data.demote_to)
    if not demote_role:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"The '{data.demote_to}' role is not configured for this organization",
        )

    # 6. Grant the NEW owner first (upsert a document-scoped assignment).
    target_assignment = await _doc_scoped_assignment(db, target.id, doc.id)
    if target_assignment:
        target_assignment.role_id = owner_role.id
    else:
        db.add(Assignment(
            org_id=current_user.org_id,
            user_id=target.id,
            role_id=owner_role.id,
            scope_type="document",
            scope_id=doc.id,
        ))

    # 7. Demote the caller at the document scope (overrides inherited ownership
    #    for this document only — never touches folder-level assignments).
    caller_assignment = await _doc_scoped_assignment(db, current_user.id, doc.id)
    if caller_assignment:
        caller_assignment.role_id = demote_role.id
    else:
        db.add(Assignment(
            org_id=current_user.org_id,
            user_id=current_user.id,
            role_id=demote_role.id,
            scope_type="document",
            scope_id=doc.id,
        ))

    # 8. Audit (append-only). NOTE: org_id is set and the JSONB column is the
    #    `meta` attribute — the correct usage for the AuditLog model.
    db.add(AuditLog(
        org_id=current_user.org_id,
        actor_id=current_user.id,
        document_id=doc.id,
        action="ownership_transfer",
        target_type="document",
        target_id=doc.id,
        meta={
            "from_user": str(current_user.id),
            "to_user": str(target.id),
            "previous_owner_role": caller_role,
            "demoted_caller_to": data.demote_to,
        },
    ))

    await db.commit()

    return {
        "success": True,
        "message": f"Ownership transferred to {target.display_name}",
        "document_id": doc.id,
        "new_owner_id": target.id,
        "previous_owner_id": current_user.id,
        "previous_owner_role": caller_role or "unknown",
        "demoted_to": data.demote_to,
    }
