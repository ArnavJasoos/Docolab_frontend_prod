import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Document, DocumentStar, User, Folder, Role, Assignment
from app.schemas.document import (
    DocumentCreate, DocumentResponse, DocumentListResponse,
    AuthorizeCheckResponse, DocumentUpdate, StarResponse,
)
from app.services.auth_service import authorize, require_permission
from app.services.audit_service import record_audit, AuditAction

router = APIRouter()


async def _grant_owner(db: AsyncSession, user: User, scope_type: str, scope_id):
    """Creator-owns: grant the creator the org's owner role on the new scope."""
    owner_role = (
        await db.execute(select(Role).where(Role.org_id == user.org_id, Role.name == "owner"))
    ).scalars().first()
    if owner_role is None:
        return
    db.add(Assignment(
        org_id=user.org_id,
        user_id=user.id,
        role_id=owner_role.id,
        scope_type=scope_type,
        scope_id=scope_id,
    ))


async def _starred_ids(db: AsyncSession, user_id, doc_ids) -> set:
    """Which of `doc_ids` THIS user has personally starred (document_stars)."""
    if not doc_ids:
        return set()
    rows = (
        await db.execute(
            select(DocumentStar.document_id).where(
                DocumentStar.user_id == user_id,
                DocumentStar.document_id.in_(doc_ids),
            )
        )
    ).scalars().all()
    return set(rows)


def _with_star(doc: Document, starred: bool) -> Document:
    """Attach the per-user `starred` flag as a transient attribute for the
    response (the documents table no longer has a global starred column)."""
    doc.starred = starred
    return doc


@router.post("", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
async def create_document(
    data: DocumentCreate, 
    db: AsyncSession = Depends(get_db), 
    current_user: User = Depends(get_current_user)
):
    # 1. Handle Permission and Folder Validation
    if data.folder_id:
        # User wants to create inside a folder
        folder = (
            await db.execute(select(Folder).where(Folder.id == data.folder_id))
        ).scalars().first()
        if not folder:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder not found")
        
        # RBAC: check edit rights on the specific folder
        await require_permission(db, current_user.id, "can_edit_direct", "folder", data.folder_id)
        scope_type = "folder"
        scope_id = data.folder_id
    else:
        # User wants to create at Root level
        # RBAC: check if they have permission to create at the Organization level
        # (Assuming you use the Org ID as the scope for root documents)
        await require_permission(db, current_user.id, "can_edit_direct", "organization", current_user.org_id)
        scope_type = "organization"
        scope_id = current_user.org_id

    # 2. Create Document
    doc_id = uuid.uuid4()
    doc = Document(
        id=doc_id,
        org_id=current_user.org_id,
        folder_id=data.folder_id, # Can be None now
        title=data.title,
        yjs_doc_key=str(doc_id),
        schema_version=1,
        status="working",
        current_version_no=0,
        offline_enabled=False,
        approval_policy_id=None,
        created_by=current_user.id
    )
    db.add(doc)
    await db.flush()

    # 3. Grant Owner permissions to creator
    await _grant_owner(db, current_user, "document", doc.id)

    # 4. Audit Log
    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.DOCUMENT_CREATE, target_type="document",
        target_id=doc.id, document_id=doc.id,
        meta={"title": doc.title, "folder_id": str(data.folder_id) if data.folder_id else "root"},
    )
    
    await db.commit()
    await db.refresh(doc)
    
    return _with_star(doc, False)


@router.get("", response_model=DocumentListResponse)
async def list_documents(
    folder_id: Optional[str] = Query(None, description="restrict to one folder; omit for org-wide"),
    trashed: Optional[bool] = Query(None, description="None=active only, true=recycle bin only, false=active only"),
    starred: bool = Query(False, description="true = only docs the current user has starred"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List documents. Always org-isolated and hides permanently-deleted docs.
    By default hides trashed docs too; pass ?trashed=true for the recycle bin.
    ?starred=true returns only the current user's personal bookmarks. Omit
    folder_id for an org-wide list (the browser's "all/starred/trash" views)."""
    query = select(Document).where(
        Document.org_id == current_user.org_id,   # org isolation
        Document.status != "deleted",             # hide permanently-deleted
    )
    if folder_id is not None:
        query = query.where(Document.folder_id == folder_id)
    if trashed is None:
        query = query.where(Document.trashed == False)  # noqa: E712  (active only)
    else:
        query = query.where(Document.trashed == bool(trashed))
    if starred:
        query = query.where(
            Document.id.in_(
                select(DocumentStar.document_id).where(DocumentStar.user_id == current_user.id)
            )
        )
    docs = (await db.execute(query)).scalars().all()
    starred_ids = await _starred_ids(db, current_user.id, [d.id for d in docs])
    return {"documents": [_with_star(d, d.id in starred_ids) for d in docs]}


@router.get("/{id}", response_model=DocumentResponse)
async def get_document(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Get a single document by ID"""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    # Permanently-deleted docs are gone for good (trashed docs are still openable
    # from the recycle bin, so only status=deleted yields 404 here).
    if not doc or doc.status == "deleted":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    starred = bool(await _starred_ids(db, current_user.id, [doc.id]))
    return _with_star(doc, starred)


@router.patch("/{id}", response_model=DocumentResponse)
async def update_document(
    id: str,
    data: DocumentUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Update a document: rename, move, or trash/restore (reversible recycle
    bin). Personal bookmarks are NOT here — see PUT/DELETE /documents/{id}/star."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # RBAC: editing a document requires edit rights on it.
    await require_permission(db, current_user.id, "can_edit_direct", "document", id)

    before, after = {}, {}
    action = AuditAction.DOCUMENT_UPDATE
    if data.title is not None:
        before["title"] = doc.title; after["title"] = data.title
        doc.title = data.title

    if data.folder_id is not None:
        folder = (
            await db.execute(select(Folder).where(Folder.id == data.folder_id, Folder.org_id == current_user.org_id))
        ).scalars().first()
        if not folder:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder not found")
        # Moving into a folder also requires edit rights on the destination.
        await require_permission(db, current_user.id, "can_edit_direct", "folder", data.folder_id)
        before["folder_id"] = str(doc.folder_id); after["folder_id"] = str(data.folder_id)
        doc.folder_id = data.folder_id

    if data.trashed is not None:
        if data.trashed:
            # Guard: cannot trash a document that is pending approval.
            if doc.status == "pending_approval":
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Cannot trash a document pending approval. Reject the submission first.",
                )
            doc.trashed_at = datetime.now(timezone.utc)
            action = AuditAction.DOCUMENT_TRASH
        else:
            doc.trashed_at = None
            action = AuditAction.DOCUMENT_RESTORE
        before["trashed"] = doc.trashed; after["trashed"] = data.trashed
        doc.trashed = data.trashed

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=action, target_type="document",
        target_id=doc.id, document_id=doc.id, meta={"before": before, "after": after},
    )
    await db.commit()
    await db.refresh(doc)
    starred = bool(await _starred_ids(db, current_user.id, [doc.id]))
    return _with_star(doc, starred)


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Permanently delete a document (terminal state status='deleted').

    This is the PERMANENT path. The reversible recycle bin is PATCH
    {"trashed": true}; permanent delete is hidden from every list forever.
    """
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # RBAC: deletion is destructive -> owner-level only.
    await require_permission(db, current_user.id, "can_manage_members", "document", id)

    # Don't destroy a document mid-review; reject the submission first.
    if doc.status == "pending_approval":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete a document pending approval. Reject the submission first.",
        )

    doc.status = "deleted"
    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.DOCUMENT_DELETE, target_type="document",
        target_id=doc.id, document_id=doc.id, meta={"permanent": True},
    )
    await db.commit()


# --- personal bookmarks (per-user; no edit rights required) -----------------

@router.put("/{id}/star", response_model=StarResponse)
async def star_document(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Add the current user's personal bookmark on a document. Idempotent.
    Requires only read access (can_view_history), NOT edit rights — a viewer
    can bookmark a read-only doc."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    await require_permission(db, current_user.id, "can_view_history", "document", id)

    existing = (
        await db.execute(
            select(DocumentStar).where(
                DocumentStar.user_id == current_user.id, DocumentStar.document_id == doc.id
            )
        )
    ).scalars().first()
    if existing is None:
        db.add(DocumentStar(user_id=current_user.id, document_id=doc.id, org_id=current_user.org_id))
        record_audit(
            db, org_id=current_user.org_id, actor_id=current_user.id,
            action=AuditAction.DOCUMENT_STAR, target_type="document",
            target_id=doc.id, document_id=doc.id,
        )
        await db.commit()
    return {"document_id": doc.id, "starred": True}


@router.delete("/{id}/star", response_model=StarResponse)
async def unstar_document(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Remove the current user's personal bookmark. Idempotent. No permission
    needed beyond being logged in — it only touches the user's own bookmark."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    existing = (
        await db.execute(
            select(DocumentStar).where(
                DocumentStar.user_id == current_user.id, DocumentStar.document_id == doc.id
            )
        )
    ).scalars().first()
    if existing is not None:
        await db.delete(existing)
        record_audit(
            db, org_id=current_user.org_id, actor_id=current_user.id,
            action=AuditAction.DOCUMENT_UNSTAR, target_type="document",
            target_id=doc.id, document_id=doc.id,
        )
        await db.commit()
    return {"document_id": doc.id, "starred": False}


@router.get("/{id}/authorize-check", response_model=AuthorizeCheckResponse)
async def check_authorization(id: str, permission: str = Query(...), db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    doc = (
        await db.execute(select(Document).where(Document.id == id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    allowed, resolved_role, via_scope = await authorize(
        db=db,
        user_id=current_user.id,
        permission=permission,
        scope_type="document",
        scope_id=id
    )
    return {
        "allowed": allowed,
        "resolved_role": resolved_role,
        "via_scope": via_scope
    }
