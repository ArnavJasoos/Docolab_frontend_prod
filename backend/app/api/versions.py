import uuid
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import (
    Document, User, Version, ApprovalMarker, ApprovalStepEvent,
    ApprovalPolicyStep, Notification, Assignment,
)
from app.schemas.version import (
    VersionResponse, VersionListResponse, VersionMetadataResponse,
    DiffResponse, SubmitForApprovalRequest, SubmitForApprovalResponse,
    ApprovalRequest, ApprovalResponse, RejectRequest, RejectResponse,
    RestoreRequest, RestoreResponse
)
from app.services.auth_service import authorize, require_permission, resolve_role
from app.services.audit_service import record_audit, AuditAction

router = APIRouter()


# --- approval-chain helpers -------------------------------------------------

async def _load_chain_state(db: AsyncSession, version_id, policy_id):
    """Return (ordered steps, {step_no: set(approved actor ids)}) for a submission."""
    steps = (
        await db.execute(
            select(ApprovalPolicyStep)
            .where(ApprovalPolicyStep.policy_id == policy_id)
            .order_by(ApprovalPolicyStep.step_no)
        )
    ).scalars().all()
    events = (
        await db.execute(
            select(ApprovalStepEvent).where(
                ApprovalStepEvent.version_id == version_id,
                ApprovalStepEvent.decision == "approved",
            )
        )
    ).scalars().all()
    approved: dict[int, set] = {}
    for e in events:
        approved.setdefault(e.step_no, set()).add(str(e.actor_id))
    return steps, approved


def _lowest_incomplete_step(steps, approved):
    """First step whose distinct approvals are below its min_approvals (or None)."""
    for s in steps:
        if len(approved.get(s.step_no, set())) < s.min_approvals:
            return s
    return None


def _mint_baseline(db: AsyncSession, doc: Document, version: Version, user: User):
    """Final approval: advance the baseline (the one place a marker is written)."""
    db.add(ApprovalMarker(
        id=uuid.uuid4(), org_id=doc.org_id, document_id=doc.id,
        approved_version_id=version.id, approved_by=user.id,
    ))
    version.kind = "approved"
    doc.current_version_no = version.version_no
    doc.status = "working"


# --- endpoints --------------------------------------------------------------

@router.get("/documents/{id}/versions", response_model=VersionListResponse)
async def list_versions(
    id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """List version history for a document."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_view_history", "document", doc.id)

    versions = (
        await db.execute(
            select(Version).where(Version.document_id == id).order_by(Version.version_no.desc())
        )
    ).scalars().all()
    return {"versions": versions}


@router.get("/versions/{id}", response_model=VersionMetadataResponse)
async def get_version(
    id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get version metadata and signed S3 URL."""
    version = (await db.execute(select(Version).where(Version.id == id))).scalars().first()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")

    doc = (
        await db.execute(select(Document).where(Document.id == version.document_id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_view_history", "document", doc.id)

    s3_url = f"s3://signed-url/{version.s3_key}"
    return {
        "id": version.id, "document_id": version.document_id,
        "version_no": version.version_no, "kind": version.kind,
        "created_by": version.created_by, "created_at": version.created_at,
        "s3_url": s3_url,
    }


@router.post("/documents/{id}/submit-for-approval", response_model=SubmitForApprovalResponse)
async def submit_for_approval(
    id: str,
    data: SubmitForApprovalRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Freeze a submission snapshot and move the document into review."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_submit_for_approval", "document", doc.id)

    if doc.trashed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot submit a trashed document for approval. Restore it first.",
        )
    if doc.status == "pending_approval":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Document is already pending approval.",
        )

    new_version_no = doc.current_version_no + 1
    version = Version(
        id=uuid.uuid4(), org_id=current_user.org_id, document_id=doc.id,
        version_no=new_version_no, kind="submission",
        s3_key=f"versions/{doc.id}/v{new_version_no}", created_by=current_user.id,
        # Snapshot the policy at submit time so the in-flight chain is
        # deterministic even if the doc's policy is edited/detached mid-review.
        approval_policy_id=doc.approval_policy_id,
    )
    db.add(version)
    doc.status = "pending_approval"
    await db.flush()

    # Notify the first approver(s) when a policy chain is attached.
    if doc.approval_policy_id is not None:
        db.add(Notification(
            id=uuid.uuid4(), org_id=current_user.org_id, user_id=current_user.id,
            document_id=doc.id, type="submission_pending",
            payload={"version_id": str(version.id), "version_no": new_version_no,
                     "submitter": str(current_user.id)},
        ))

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.SUBMIT, target_type="version",
        target_id=version.id, document_id=doc.id, meta={"version_no": new_version_no},
    )
    await db.commit()
    await db.refresh(version)

    return {
        "version_id": str(version.id), "version_no": new_version_no,
        "message": f"Submitted for approval (version {new_version_no})",
    }


@router.get("/documents/{id}/diff")
async def get_diff(
    id: str,
    from_v: int = Query(..., alias="from"),
    to_v: int = Query(..., alias="to"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Compute diff between two versions (owner review + team comparison)."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_view_history", "document", doc.id)

    from_version = (
        await db.execute(select(Version).where(Version.document_id == id, Version.version_no == from_v))
    ).scalars().first()
    to_version = (
        await db.execute(select(Version).where(Version.document_id == id, Version.version_no == to_v))
    ).scalars().first()
    if not from_version or not to_version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="One or both versions not found")

    return {
        "from_version_no": from_v, "to_version_no": to_v,
        "diff_content": {
            "from_s3_key": from_version.s3_key, "to_s3_key": to_version.s3_key,
            "message": "Diff computation would be performed against S3 blobs",
        },
    }


async def _get_submission_or_404(db: AsyncSession, version_id, org_id):
    """Load a version + its document, ensuring the version is still pending."""
    version = (await db.execute(select(Version).where(Version.id == version_id))).scalars().first()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")
    doc = (
        await db.execute(select(Document).where(Document.id == version.document_id, Document.org_id == org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    if version.kind != "submission":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Version is not pending approval (state: {version.kind})",
        )
    return version, doc


@router.post("/versions/{id}/approve", response_model=ApprovalResponse)
async def approve_version(
    id: str,
    data: ApprovalRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Approve a submission.

    NULL policy  -> single owner gate: requires can_give_final_approval, mints the
                    baseline immediately (original behaviour, preserved).
    Policy set   -> ordered chain: the caller must hold the lowest-incomplete
                    step's required role + can_approve_level; their approval is
                    recorded; the baseline advances ONLY when the final step's
                    min_approvals are all met.
    """
    version, doc = await _get_submission_or_404(db, id, current_user.org_id)
    # Resolve against the policy SNAPSHOTTED on the submission, not the doc's
    # live policy, so mid-review edits/detaches can't corrupt this chain.
    policy_id = version.approval_policy_id

    # ---- single owner gate ----
    if policy_id is None:
        await require_permission(db, current_user.id, "can_give_final_approval", "document", doc.id)
        _mint_baseline(db, doc, version, current_user)
        record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                     action=AuditAction.APPROVE, target_type="version",
                     target_id=version.id, document_id=doc.id,
                     meta={"version_no": version.version_no, "mode": "single_gate"})
        await db.commit()
        return {"success": True, "message": f"Version {version.version_no} approved"}

    # ---- multi-step chain ----
    steps, approved = await _load_chain_state(db, version.id, policy_id)
    if not steps:  # policy with no steps configured -> behave as single gate
        await require_permission(db, current_user.id, "can_give_final_approval", "document", doc.id)
        _mint_baseline(db, doc, version, current_user)
        record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                     action=AuditAction.APPROVE, target_type="version",
                     target_id=version.id, document_id=doc.id,
                     meta={"version_no": version.version_no, "mode": "empty_policy"})
        await db.commit()
        return {"success": True, "message": f"Version {version.version_no} approved"}

    step = _lowest_incomplete_step(steps, approved)
    if step is None:  # defensive: chain already complete
        _mint_baseline(db, doc, version, current_user)
        record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                     action=AuditAction.APPROVE, target_type="version",
                     target_id=version.id, document_id=doc.id, meta={"mode": "chain_complete"})
        await db.commit()
        return {"success": True, "message": f"Version {version.version_no} approved"}

    # The caller must hold THIS step's required role (effective role on the doc)
    role_id, role_name, _ = await resolve_role(db, current_user.id, "document", doc.id)
    if role_id != step.required_role_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Step {step.step_no} must be approved by the required role for this step",
        )
    has_level, _, _ = await authorize(db, current_user.id, "can_approve_level", "document", doc.id)
    if not has_level:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Forbidden: requires 'can_approve_level' on this document")
    if str(current_user.id) in approved.get(step.step_no, set()):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"You have already approved step {step.step_no}")

    db.add(ApprovalStepEvent(
        id=uuid.uuid4(), org_id=current_user.org_id, document_id=doc.id,
        version_id=version.id, policy_id=policy_id, step_no=step.step_no,
        decision="approved", actor_id=current_user.id,
    ))
    approved.setdefault(step.step_no, set()).add(str(current_user.id))

    if _lowest_incomplete_step(steps, approved) is None:
        # final step satisfied -> baseline advances
        _mint_baseline(db, doc, version, current_user)
        record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                     action=AuditAction.APPROVE, target_type="version",
                     target_id=version.id, document_id=doc.id,
                     meta={"version_no": version.version_no, "final_step": step.step_no})
        msg = f"Version {version.version_no} approved (chain complete)"
    else:
        record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                     action=AuditAction.APPROVE_STEP, target_type="version",
                     target_id=version.id, document_id=doc.id, meta={"step_no": step.step_no})
        remaining = sum(1 for s in steps if len(approved.get(s.step_no, set())) < s.min_approvals)
        msg = f"Step {step.step_no} approved; {remaining} step(s) remaining"

    await db.commit()
    return {"success": True, "message": msg}


@router.post("/versions/{id}/reject", response_model=RejectResponse)
async def reject_version(
    id: str,
    data: RejectRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Reject a submission. Baseline stays; the submission is discarded and the
    document returns to working. A rejection at any step ends the cycle."""
    version, doc = await _get_submission_or_404(db, id, current_user.org_id)
    policy_id = version.approval_policy_id  # snapshot taken at submit

    if policy_id is None:
        await require_permission(db, current_user.id, "can_give_final_approval", "document", doc.id)
    else:
        # A chain approver (current step's role + can_approve_level) may reject.
        steps, approved = await _load_chain_state(db, version.id, policy_id)
        step = _lowest_incomplete_step(steps, approved) or (steps[-1] if steps else None)
        role_id, _, _ = await resolve_role(db, current_user.id, "document", doc.id)
        has_level, _, _ = await authorize(db, current_user.id, "can_approve_level", "document", doc.id)
        if step is None or role_id != step.required_role_id or not has_level:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only an approver for the current step may reject this submission",
            )
        db.add(ApprovalStepEvent(
            id=uuid.uuid4(), org_id=current_user.org_id, document_id=doc.id,
            version_id=version.id, policy_id=policy_id, step_no=step.step_no,
            decision="rejected", actor_id=current_user.id,
        ))

    version.kind = "rejected"
    doc.status = "working"
    record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                 action=AuditAction.REJECT, target_type="version",
                 target_id=version.id, document_id=doc.id, meta={"version_no": version.version_no})
    await db.commit()
    return {"success": True, "message": f"Version {version.version_no} rejected"}


@router.post("/versions/{id}/restore", response_model=RestoreResponse)
async def restore_version(
    id: str,
    data: RestoreRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Restore a deleted section (stays pending)."""
    version = (await db.execute(select(Version).where(Version.id == id))).scalars().first()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")
    doc = (
        await db.execute(select(Document).where(Document.id == version.document_id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await require_permission(db, current_user.id, "can_edit_direct", "document", doc.id)

    record_audit(db, org_id=current_user.org_id, actor_id=current_user.id,
                 action=AuditAction.RESTORE, target_type="version",
                 target_id=version.id, document_id=doc.id,
                 meta={"section_id": str(data.section_id)})
    await db.commit()
    return {"success": True, "message": f"Section restored in version {version.version_no}"}
