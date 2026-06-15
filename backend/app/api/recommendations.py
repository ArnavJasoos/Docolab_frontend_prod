# =============================================================================
# app/api/recommendations.py  (Person A — Collaboration: Recommendations)
#
# Endpoints:
#   GET   /versions/{id}/recommendations        list owner notes on a version
#   POST  /versions/{id}/recommendations        create (accompanies approve/reject)
#   PATCH /recommendations/{id}                  update status (open/addressed/orphaned)
#   GET   /recommendations/{id}/responses        full response thread (oldest -> newest)
#   POST  /recommendations/{id}/responses        post response (APPEND-ONLY: no PATCH/DELETE)
#
# Mounted at prefix=settings.API_STR ("/api"). Async SQLAlchemy, real DB,
# authorize() on mutating endpoints.
# =============================================================================

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import (
    User, Version, Recommendation, RecommendationResponse,
)
from app.schemas.recommendation import (
    RecommendationCreate, RecommendationUpdate, RecommendationOut,
    RecommendationListResponse, RecommendationResponseCreate,
    RecommendationResponseOut, RecommendationResponseListResponse,
)
from app.services.auth_service import authorize

router = APIRouter()


async def _check_permission(db: AsyncSession, user_id, doc_id, permission: str):
    has_perm, _, _ = await authorize(db, user_id, permission, "document", doc_id)
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"You do not have permission to {permission}",
        )


async def _get_version_or_404(db: AsyncSession, version_id, org_id) -> Version:
    v = (
        await db.execute(
            select(Version).where(Version.id == version_id, Version.org_id == org_id)
        )
    ).scalars().first()
    if not v:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Version not found"
        )
    return v


async def _get_recommendation_or_404(db: AsyncSession, rec_id, org_id) -> Recommendation:
    r = (
        await db.execute(
            select(Recommendation).where(
                Recommendation.id == rec_id, Recommendation.org_id == org_id
            )
        )
    ).scalars().first()
    if not r:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Recommendation not found"
        )
    return r


@router.get("/versions/{id}/recommendations", response_model=RecommendationListResponse)
async def list_recommendations(
    id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List the owner's recommendations attached to a version."""
    await _get_version_or_404(db, id, current_user.org_id)

    rows = (
        await db.execute(
            select(Recommendation)
            .where(
                Recommendation.version_id == id,
                Recommendation.org_id == current_user.org_id,
            )
            .order_by(Recommendation.created_at.asc())
        )
    ).scalars().all()
    return {"recommendations": rows}


@router.post(
    "/versions/{id}/recommendations",
    response_model=RecommendationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_recommendation(
    id: str,
    data: RecommendationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a recommendation on a version (accompanies an approve or reject)."""
    version = await _get_version_or_404(db, id, current_user.org_id)
    await _check_permission(db, current_user.id, version.document_id, "can_give_final_approval")

    rec = Recommendation(
        org_id=current_user.org_id,
        document_id=version.document_id,
        version_id=version.id,
        author_id=current_user.id,
        anchor=data.anchor,
        body=data.body,
        status="open",
    )
    db.add(rec)
    await db.commit()
    await db.refresh(rec)
    return rec


@router.patch("/recommendations/{id}", response_model=RecommendationOut)
async def update_recommendation(
    id: str,
    data: RecommendationUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a recommendation's status (open / addressed / orphaned)."""
    rec = await _get_recommendation_or_404(db, id, current_user.org_id)
    await _check_permission(db, current_user.id, rec.document_id, "can_give_final_approval")

    rec.status = data.status
    await db.commit()
    await db.refresh(rec)
    return rec


@router.get(
    "/recommendations/{id}/responses",
    response_model=RecommendationResponseListResponse,
)
async def list_responses(
    id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get the full response thread for a recommendation (oldest -> newest)."""
    # Org isolation enforced by resolving the parent recommendation first.
    await _get_recommendation_or_404(db, id, current_user.org_id)

    rows = (
        await db.execute(
            select(RecommendationResponse)
            .where(RecommendationResponse.recommendation_id == id)
            .order_by(RecommendationResponse.created_at.asc())
        )
    ).scalars().all()
    return {"responses": rows}


@router.post(
    "/recommendations/{id}/responses",
    response_model=RecommendationResponseOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_response(
    id: str,
    data: RecommendationResponseCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Post a team response to a recommendation. APPEND-ONLY by design — there
    is intentionally no PATCH or DELETE on recommendation_responses."""
    rec = await _get_recommendation_or_404(db, id, current_user.org_id)
    await _check_permission(db, current_user.id, rec.document_id, "can_suggest")

    response = RecommendationResponse(
        recommendation_id=rec.id,
        author_id=current_user.id,
        body=data.body,
    )
    db.add(response)
    await db.commit()
    await db.refresh(response)
    return response
