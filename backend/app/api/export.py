from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User, Document, Version
from app.schemas.export import ExportResponse
from app.services.auth_service import authorize

router = APIRouter()


async def check_permission(db: AsyncSession, user_id, doc_id, permission: str):
    """Helper to check permission and raise 403 if denied."""
    has_perm, _, _ = await authorize(db, user_id, permission, "document", doc_id)
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You do not have permission to {permission}"
        )


@router.get("/documents/{id}/export", response_model=ExportResponse)
async def export_document(
    id: str,
    format: str = Query(..., pattern="^(md|docx)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Render current document (markdown or docx format)."""
    doc = (
        await db.execute(select(Document).where(Document.id == id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await check_permission(db, current_user.id, doc.id, "can_view_history")

    content = f"# {doc.title}\n\nDocument content would be fetched from Hocuspocus"

    if format == "docx":
        content = f"DOCX: {content}"
        file_name = f"{doc.title}.docx"
    else:
        file_name = f"{doc.title}.md"

    return {
        "document_id": str(doc.id),
        "version_no": None,
        "format": format,
        "content": content,
        "file_name": file_name
    }


@router.get("/versions/{id}/export", response_model=ExportResponse)
async def export_version(
    id: str,
    format: str = Query(..., pattern="^(md|docx)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Render an approved version (markdown or docx format)."""
    version = (await db.execute(select(Version).where(Version.id == id))).scalars().first()
    if not version:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found")

    doc = (
        await db.execute(select(Document).where(Document.id == version.document_id, Document.org_id == current_user.org_id))
    ).scalars().first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")

    await check_permission(db, current_user.id, doc.id, "can_view_history")

    content = f"# {doc.title}\n\nVersion {version.version_no} content from S3"

    if format == "docx":
        content = f"DOCX: {content}"
        file_name = f"{doc.title}_v{version.version_no}.docx"
    else:
        file_name = f"{doc.title}_v{version.version_no}.md"

    return {
        "document_id": str(doc.id),
        "version_no": version.version_no,
        "format": format,
        "content": content,
        "file_name": file_name
    }
