# =============================================================================
# app/api/comments.py  (Person A — Collaboration: Comments)
#
# Endpoints:
#   GET  /documents/{id}/comments        list (optional ?since= ISO datetime)
#   POST /documents/{id}/comments        post a comment (threaded via parent_comment_id)
#
# Mounted at prefix=settings.API_STR ("/api") -> /api/documents/{id}/comments.
# Async SQLAlchemy, wired to the real DB, with an authorize() guard on the
# mutating endpoint (mirrors the team's pattern).
# =============================================================================

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import User, Document, Comment, Suggestion
from app.schemas.comment import CommentCreate, CommentOut, CommentListResponse
from app.services.auth_service import authorize

router = APIRouter()


async def _get_document_or_404(db: AsyncSession, doc_id, org_id) -> Document:
    doc = (
        await db.execute(
            select(Document).where(Document.id == doc_id, Document.org_id == org_id)
        )
    ).scalars().first()
    if not doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Document not found"
        )
    return doc


@router.get("/documents/{id}/comments", response_model=CommentListResponse)
async def list_comments(
    id: str,
    since: datetime | None = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List comments on a document, optionally bounded by ?since=<ISO datetime>."""
    await _get_document_or_404(db, id, current_user.org_id)

    query = select(Comment).where(
        Comment.document_id == id,
        Comment.org_id == current_user.org_id,
    )
    if since is not None:
        query = query.where(Comment.created_at >= since)
    query = query.order_by(Comment.created_at.asc())

    rows = (await db.execute(query)).scalars().all()
    return {"comments": rows}


@router.post(
    "/documents/{id}/comments",
    response_model=CommentOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    id: str,
    data: CommentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Post a comment. Optionally linked to a suggestion and/or a parent comment."""
    doc = await _get_document_or_404(db, id, current_user.org_id)

    # Posting to the document's collaboration surface requires participation.
    has_perm, _, _ = await authorize(db, current_user.id, "can_suggest", "document", doc.id)
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to can_suggest",
        )

    # Validate optional foreign keys belong to the same document/org.
    if data.suggestion_id is not None:
        linked = (
            await db.execute(
                select(Suggestion).where(
                    Suggestion.id == data.suggestion_id,
                    Suggestion.document_id == doc.id,
                )
            )
        ).scalars().first()
        if not linked:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Linked suggestion not found on this document",
            )

    if data.parent_comment_id is not None:
        parent = (
            await db.execute(
                select(Comment).where(
                    Comment.id == data.parent_comment_id,
                    Comment.document_id == doc.id,
                )
            )
        ).scalars().first()
        if not parent:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Parent comment not found on this document",
            )

    comment = Comment(
        org_id=current_user.org_id,
        document_id=doc.id,
        suggestion_id=data.suggestion_id,
        anchor=data.anchor,
        author_id=current_user.id,
        body=data.body,
        parent_comment_id=data.parent_comment_id,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return comment
