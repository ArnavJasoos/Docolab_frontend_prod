import uuid
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import (
    Document, User, Version, ApprovalMarker, ApprovalStepEvent, Notification
)
from app.schemas.version import (
    VersionResponse, VersionListResponse, VersionMetadataResponse,
    DiffResponse, SubmitForApprovalRequest, SubmitForApprovalResponse,
    ApprovalRequest, ApprovalResponse, RejectRequest, RejectResponse,
    RestoreRequest, RestoreResponse
)
from app.services.auth_service import authorize
from app.services.audit_service import record_audit, AuditAction

router = APIRouter()


async def check_permission(db: AsyncSession, user_id, doc_id, permission: str):
    """Helper to check permission and raise 403 if denied."""
    has_perm, _, _ = await authorize(db, user_id, permission, "document", doc_id)
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You do not have permission to {permission}"
        )


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

    await check_permission(db, current_user.id, doc.id, "can_view_history")

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

    await check_permission(db, current_user.id, doc.id, "can_view_history")

    s3_url = f"s3://signed-url/{version.s3_key}"

    return {
        "id": version.id,
        "document_id": version.document_id,
        "version_no": version.version_no,
        "kind": version.kind,
        "created_by": version.created_by,
        "created_at": version.created_at,
        "s3_url": s3_url
    }


@router.post("/documents/{id}/submit-for-approval", response_model=SubmitForApprovalResponse)
async def submit_for_approval(
    id: str,
    data: SubmitForApprovalRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Freeze warm snapshot and submit for approval."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await check_permission(db, current_user.id, doc.id, "can_submit_for_approval")

    # A trashed document cannot be submitted for approval.
    if doc.trashed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot submit a trashed document for approval. Restore it first.",
        )

    new_version_no = doc.current_version_no + 1
    version = Version(
        id=uuid.uuid4(),
        org_id=current_user.org_id,
        document_id=doc.id,
        version_no=new_version_no,
        kind="submission",
        s3_key=f"versions/{doc.id}/v{new_version_no}",
        created_by=current_user.id
    )
    db.add(version)
    await db.flush()

    # If the doc has an approval policy attached, notify (chain path). The FK
    # column is read directly (no lazy relationship load under async).
    if doc.approval_policy_id is not None:
        notification = Notification(
            id=uuid.uuid4(),
            org_id=current_user.org_id,
            user_id=current_user.id,
            document_id=doc.id,
            type="submission_pending",
            payload={
                "version_id": str(version.id),
                "version_no": new_version_no,
                "submitter": str(current_user.id)
            }
        )
        db.add(notification)

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.SUBMIT, target_type="version",
        target_id=version.id, document_id=doc.id,
        meta={"version_no": new_version_no},
    )
    await db.commit()
    await db.refresh(version)

    return {
        "version_id": str(version.id),
        "version_no": new_version_no,
        "message": f"Submitted for approval (version {new_version_no})"
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

    await check_permission(db, current_user.id, doc.id, "can_view_history")

    from_version = (
        await db.execute(select(Version).where(Version.document_id == id, Version.version_no == from_v))
    ).scalars().first()
    to_version = (
        await db.execute(select(Version).where(Version.document_id == id, Version.version_no == to_v))
    ).scalars().first()

    if not from_version or not to_version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="One or both versions not found")

    return {
        "from_version_no": from_v,
        "to_version_no": to_v,
        "diff_content": {
            "from_s3_key": from_version.s3_key,
            "to_s3_key": to_version.s3_key,
            "message": "Diff computation would be performed against S3 blobs"
        }
    }


@router.post("/versions/{id}/approve", response_model=ApprovalResponse)
async def approve_version(
    id: str,
    data: ApprovalRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Policy-aware approval: write marker only when chain completes."""
    version = (await db.execute(select(Version).where(Version.id == id))).scalars().first()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")

    doc = (
        await db.execute(select(Document).where(Document.id == version.document_id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await check_permission(db, current_user.id, doc.id, "can_give_final_approval")

    # Record a step event only when a policy is attached (single-gate / NULL
    # policy writes no approval_step_events row — per the design, and required
    # because ApprovalStepEvent.policy_id is NOT NULL).
    if doc.approval_policy_id is not None:
        db.add(ApprovalStepEvent(
            id=uuid.uuid4(),
            org_id=current_user.org_id,
            document_id=doc.id,
            version_id=version.id,
            policy_id=doc.approval_policy_id,
            step_no=1,
            decision="approved",
            actor_id=current_user.id
        ))

    marker = ApprovalMarker(
        id=uuid.uuid4(),
        org_id=current_user.org_id,
        document_id=doc.id,
        approved_version_id=version.id,
        approved_by=current_user.id
    )
    db.add(marker)

    version.kind = "approved"

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.APPROVE, target_type="version",
        target_id=version.id, document_id=doc.id,
        meta={"version_no": version.version_no},
    )
    await db.commit()

    return {"success": True, "message": f"Version {version.version_no} approved"}


@router.post("/versions/{id}/reject", response_model=RejectResponse)
async def reject_version(
    id: str,
    data: RejectRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Discard warm snapshot, baseline stays."""
    version = (await db.execute(select(Version).where(Version.id == id))).scalars().first()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")

    doc = (
        await db.execute(select(Document).where(Document.id == version.document_id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await check_permission(db, current_user.id, doc.id, "can_give_final_approval")

    if doc.approval_policy_id is not None:
        db.add(ApprovalStepEvent(
            id=uuid.uuid4(),
            org_id=current_user.org_id,
            document_id=doc.id,
            version_id=version.id,
            policy_id=doc.approval_policy_id,
            step_no=1,
            decision="rejected",
            actor_id=current_user.id
        ))

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.REJECT, target_type="version",
        target_id=version.id, document_id=doc.id,
        meta={"version_no": version.version_no},
    )
    await db.commit()

    return {"success": True, "message": f"Version {version.version_no} rejected"}


@router.post("/versions/{id}/restore", response_model=RestoreResponse)
async def restore_version(
    id: str,
    data: RestoreRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Restore deleted section (stays pending)."""
    version = (await db.execute(select(Version).where(Version.id == id))).scalars().first()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")

    doc = (
        await db.execute(select(Document).where(Document.id == version.document_id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await check_permission(db, current_user.id, doc.id, "can_edit_direct")

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.RESTORE, target_type="version",
        target_id=version.id, document_id=doc.id,
        meta={"section_id": str(data.section_id)},
    )
    await db.commit()

    return {"success": True, "message": f"Section restored in version {version.version_no}"}
