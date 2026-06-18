import uuid
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Document, User, Folder, Role, Assignment
from app.schemas.document import DocumentCreate, DocumentResponse, DocumentListResponse, AuthorizeCheckResponse, DocumentUpdate
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


@router.post("", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
async def create_document(data: DocumentCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    folder = (
        await db.execute(select(Folder).where(Folder.id == data.folder_id))
    ).scalars().first()
    if not folder:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder not found")

    # RBAC: you may only create a document in a folder you can edit.
    await require_permission(db, current_user.id, "can_edit_direct", "folder", data.folder_id)

    doc_id = uuid.uuid4()
    doc = Document(
        id=doc_id,
        org_id=current_user.org_id,
        folder_id=data.folder_id,
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
    # Creator becomes owner of the document they create (document-scoped), so a
    # junior asked to "create the document" owns it and can later hand it over.
    await _grant_owner(db, current_user, "document", doc.id)
    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.DOCUMENT_CREATE, target_type="document",
        target_id=doc.id, document_id=doc.id,
        meta={"title": doc.title, "folder_id": str(doc.folder_id)},
    )
    await db.commit()
    await db.refresh(doc)
    return doc

@router.get("", response_model=DocumentListResponse)
async def list_documents(folder_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    docs = (
        await db.execute(select(Document).where(Document.folder_id == folder_id))
    ).scalars().all()
    return {"documents": docs}

@router.get("/{id}", response_model=DocumentResponse)
async def get_document(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Get a single document by ID"""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return doc

@router.patch("/{id}", response_model=DocumentResponse)
async def update_document(
    id: str,
    data: DocumentUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Update document (rename, move, star, or trash)"""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # RBAC: editing a document requires edit rights on it.
    await require_permission(db, current_user.id, "can_edit_direct", "document", id)

    changed = {}
    if data.title is not None:
        changed["title"] = data.title
        doc.title = data.title

    if data.folder_id is not None:
        folder = (
            await db.execute(select(Folder).where(Folder.id == data.folder_id, Folder.org_id == current_user.org_id))
        ).scalars().first()
        if not folder:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder not found")
        # Moving into a folder also requires edit rights on the destination.
        await require_permission(db, current_user.id, "can_edit_direct", "folder", data.folder_id)
        changed["folder_id"] = str(data.folder_id)
        doc.folder_id = data.folder_id

    if data.starred is not None:
        changed["starred"] = data.starred
        doc.starred = data.starred

    if data.trashed is not None:
        # Guard: cannot trash a document that is pending approval.
        if data.trashed and doc.status == "pending_approval":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot trash a document pending approval. Reject the submission first.",
            )
        changed["trashed"] = data.trashed
        doc.trashed = data.trashed

    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.DOCUMENT_UPDATE, target_type="document",
        target_id=doc.id, document_id=doc.id, meta={"changed": changed},
    )
    await db.commit()
    await db.refresh(doc)
    return doc


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Soft delete a document"""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    # RBAC: deletion is destructive -> owner-level only.
    await require_permission(db, current_user.id, "can_manage_members", "document", id)

    doc.status = "deleted"
    record_audit(
        db, org_id=current_user.org_id, actor_id=current_user.id,
        action=AuditAction.DOCUMENT_DELETE, target_type="document",
        target_id=doc.id, document_id=doc.id, meta={"soft_delete": True},
    )
    await db.commit()

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
