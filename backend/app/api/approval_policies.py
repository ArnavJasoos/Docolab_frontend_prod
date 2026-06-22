# =============================================================================
# app/api/approval_policies.py  (Governance — dynamic approval chains)
#
# Endpoints (mounted at prefix=settings.API_STR -> /api):
#   GET   /approval-policies              list the org's policies + their steps
#   POST  /approval-policies              create a policy + ordered steps
#   PATCH /approval-policies/{id}         rename / toggle active / replace steps
#   PATCH /documents/{id}/approval-policy attach or detach a policy on a document
#   GET   /versions/{id}/approval-status  chain progress for a submission
#
# A policy is an ordered ladder of steps; each step requires a ROLE (resolved
# against assignments at approval time) and a min_approvals count. The actual
# chain walk lives in versions.approve/reject; this module manages the policy
# definitions and reports progress. NULL policy on a document == single owner
# gate (the original behaviour).
#
# Policy administration is org-admin-level (can_manage_approval_policy on the
# org scope); attaching a policy to a document needs that permission on the doc.
# =============================================================================

import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import (
    User, Document, Version, Role, ApprovalPolicy, ApprovalPolicyStep, ApprovalStepEvent,
)
from app.schemas.approval_policy import (
    ApprovalPolicyCreate, ApprovalPolicyUpdate, ApprovalPolicyOut,
    ApprovalPolicyListResponse, AttachPolicyRequest, AttachPolicyResponse,
    ApprovalStatusResponse,
)
from app.services.auth_service import require_permission
from app.services.audit_service import record_audit, AuditAction

router = APIRouter()


async def _policy_out(db: AsyncSession, policy: ApprovalPolicy) -> dict:
    """Build the policy response, loading steps explicitly (no async lazy-load)."""
    steps = (
        await db.execute(
            select(ApprovalPolicyStep)
            .where(ApprovalPolicyStep.policy_id == policy.id)
            .order_by(ApprovalPolicyStep.step_no)
        )
    ).scalars().all()
    return {
        "id": policy.id, "name": policy.name, "is_active": policy.is_active,
        "steps": [
            {"step_no": s.step_no, "required_role_id": s.required_role_id, "min_approvals": s.min_approvals}
            for s in steps
        ],
    }


async def _validate_steps(db: AsyncSession, org_id, steps):
    """Steps must reference roles in the org and have unique step numbers."""
    role_ids = {
        r.id for r in (await db.execute(select(Role).where(Role.org_id == org_id))).scalars().all()
    }
    seen = set()
    for s in steps:
        if s.required_role_id not in role_ids:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"Step {s.step_no}: role not found in this org")
        if s.step_no in seen:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"Duplicate step_no {s.step_no}")
        seen.add(s.step_no)


@router.get("/approval-policies", response_model=ApprovalPolicyListResponse)
async def list_policies(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """List the org's approval policies (reference data; any member may read)."""
    policies = (
        await db.execute(select(ApprovalPolicy).where(ApprovalPolicy.org_id == current_user.org_id))
    ).scalars().all()
    return {"policies": [await _policy_out(db, p) for p in policies]}


@router.post("/approval-policies", response_model=ApprovalPolicyOut, status_code=status.HTTP_201_CREATED)
async def create_policy(
    data: ApprovalPolicyCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a policy + its ordered steps (org-admin only)."""
    await require_permission(db, current_user.id, "can_manage_approval_policy", "org", current_user.org_id)
    if not data.steps:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A policy needs at least one step")
    await _validate_steps(db, current_user.org_id, data.steps)

    policy = ApprovalPolicy(
        id=uuid.uuid4(), org_id=current_user.org_id, name=data.name,
        is_active=True, created_by=current_user.id,
    )
    db.add(policy)
    await db.flush()
    for s in data.steps:
        db.add(ApprovalPolicyStep(
            id=uuid.uuid4(), org_id=current_user.org_id, policy_id=policy.id,
            step_no=s.step_no, required_role_id=s.required_role_id, min_approvals=s.min_approvals,
        ))
    record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                 action=AuditAction.POLICY_CREATE, target_type="approval_policy",
                 target_id=policy.id, meta={"name": data.name, "steps": len(data.steps)})
    await db.commit()
    await db.refresh(policy)
    return await _policy_out(db, policy)


@router.patch("/approval-policies/{id}", response_model=ApprovalPolicyOut)
async def update_policy(
    id: str,
    data: ApprovalPolicyUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Rename / toggle is_active / replace steps (org-admin only). In-flight
    submissions are unaffected — they resolve against events already recorded."""
    await require_permission(db, current_user.id, "can_manage_approval_policy", "org", current_user.org_id)
    policy = (
        await db.execute(select(ApprovalPolicy).where(ApprovalPolicy.id == id, ApprovalPolicy.org_id == current_user.org_id))
    ).scalars().first()
    if not policy:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Policy not found")

    if data.name is not None:
        policy.name = data.name
    if data.is_active is not None:
        policy.is_active = data.is_active
    if data.steps is not None:
        if not data.steps:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A policy needs at least one step")
        await _validate_steps(db, current_user.org_id, data.steps)
        existing = (
            await db.execute(select(ApprovalPolicyStep).where(ApprovalPolicyStep.policy_id == policy.id))
        ).scalars().all()
        for s in existing:
            await db.delete(s)
        await db.flush()
        for s in data.steps:
            db.add(ApprovalPolicyStep(
                id=uuid.uuid4(), org_id=current_user.org_id, policy_id=policy.id,
                step_no=s.step_no, required_role_id=s.required_role_id, min_approvals=s.min_approvals,
            ))

    record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                 action=AuditAction.POLICY_UPDATE, target_type="approval_policy", target_id=policy.id,
                 meta={"name": policy.name, "is_active": policy.is_active,
                       "steps_replaced": data.steps is not None})
    await db.commit()
    await db.refresh(policy)
    return await _policy_out(db, policy)


@router.patch("/documents/{id}/approval-policy", response_model=AttachPolicyResponse)
async def set_document_policy(
    id: str,
    data: AttachPolicyRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Attach a policy to a document (multi-step chain) or detach (None -> single
    owner gate). Requires can_manage_approval_policy on the document."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_manage_approval_policy", "document", doc.id)

    if data.policy_id is not None:
        policy = (
            await db.execute(select(ApprovalPolicy).where(ApprovalPolicy.id == data.policy_id, ApprovalPolicy.org_id == current_user.org_id))
        ).scalars().first()
        if not policy:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Policy not found")
        doc.approval_policy_id = data.policy_id
        msg = "attached"
    else:
        doc.approval_policy_id = None
        msg = "detached (reverts to single owner gate)"

    record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                 action=AuditAction.POLICY_ATTACH, target_type="document", target_id=doc.id,
                 document_id=doc.id, meta={"policy_id": str(data.policy_id) if data.policy_id else None})
    await db.commit()
    return {"success": True, "message": f"Approval policy {msg}", "approval_policy_id": doc.approval_policy_id}


@router.get("/versions/{id}/approval-status", response_model=ApprovalStatusResponse)
async def approval_status(
    id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Show chain progress for a submission: per-step approvals, the next step,
    and whether the baseline can advance. NULL policy -> single_gate."""
    version = (await db.execute(select(Version).where(Version.id == id))).scalars().first()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")
    doc = (
        await db.execute(select(Document).where(Document.id == version.document_id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_view_history", "document", doc.id)

    # Resolve against the policy snapshotted on the submission (set at submit),
    # not the document's live policy — matches versions.approve/reject.
    snapshot_policy_id = version.approval_policy_id
    if snapshot_policy_id is None:
        return {"single_gate": True}

    steps = (
        await db.execute(
            select(ApprovalPolicyStep)
            .where(ApprovalPolicyStep.policy_id == snapshot_policy_id)
            .order_by(ApprovalPolicyStep.step_no)
        )
    ).scalars().all()
    events = (
        await db.execute(
            select(ApprovalStepEvent).where(
                ApprovalStepEvent.version_id == version.id,
                ApprovalStepEvent.decision == "approved",
            )
        )
    ).scalars().all()
    approved: dict[int, set] = {}
    for e in events:
        approved.setdefault(e.step_no, set()).add(str(e.actor_id))

    step_status, next_step, complete = [], None, True
    for s in steps:
        cnt = len(approved.get(s.step_no, set()))
        done = cnt >= s.min_approvals
        step_status.append({
            "step_no": s.step_no, "required_role_id": s.required_role_id,
            "min_approvals": s.min_approvals, "approvals": cnt, "complete": done,
        })
        if not done:
            complete = False
            if next_step is None:
                next_step = s.step_no

    return {
        "single_gate": False, "policy_id": snapshot_policy_id,
        "steps": step_status, "next_step": next_step, "complete": complete,
    }
