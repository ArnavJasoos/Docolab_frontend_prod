import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Folder, User, Document, Role, Assignment
from app.schemas.folder import FolderCreate, FolderResponse, FolderUpdate, FolderTreeItem, FolderListResponse

router = APIRouter()


async def _grant_owner(db: AsyncSession, user: User, scope_type: str, scope_id):
    """Creator-owns: give `user` the org's owner role on a newly created scope.

    This is the "first role assignment to the owner" bootstrap — the person who
    creates a folder/document owns it, which is what lets a brand-new member do
    anything at all (and later hand ownership over). No-op if the owner role
    isn't seeded for the org.
    """
    owner_role = (
        await db.execute(
            select(Role).where(Role.org_id == user.org_id, Role.name == "owner")
        )
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


@router.post("", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
async def create_folder(data: FolderCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if data.parent_folder_id:
        parent = (
            await db.execute(select(Folder).where(Folder.id == data.parent_folder_id))
        ).scalars().first()
        if not parent:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent folder not found")

    folder = Folder(
        id=uuid.uuid4(),
        org_id=current_user.org_id,
        parent_folder_id=data.parent_folder_id,
        name=data.name,
        created_by=current_user.id
    )
    db.add(folder)
    await db.flush()
    await _grant_owner(db, current_user, "folder", folder.id)
    await db.commit()
    await db.refresh(folder)
    return folder

@router.get("", response_model=FolderListResponse)
async def list_folders(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """List all folders in the current user's organization"""
    folders = (
        await db.execute(select(Folder).where(Folder.org_id == current_user.org_id))
    ).scalars().all()
    items = [
        FolderTreeItem(
            id=f.id,
            name=f.name,
            parent_folder_id=f.parent_folder_id,
            created_by=f.created_by,
            created_at=f.created_at,
        )
        for f in folders
    ]
    return {"folders": items}

@router.get("/{id}", response_model=FolderResponse)
async def get_folder(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Get a single folder by ID"""
    folder = (
        await db.execute(select(Folder).where(Folder.id == id, Folder.org_id == current_user.org_id))
    ).scalars().first()
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")
    return folder

@router.patch("/{id}", response_model=FolderResponse)
async def update_folder(
    id: str,
    data: FolderUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Update folder (rename or move to different parent)"""
    folder = (
        await db.execute(select(Folder).where(Folder.id == id, Folder.org_id == current_user.org_id))
    ).scalars().first()
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")

    if data.name is not None:
        folder.name = data.name

    if data.parent_folder_id is not None:
        if data.parent_folder_id:
            parent = (
                await db.execute(select(Folder).where(Folder.id == data.parent_folder_id, Folder.org_id == current_user.org_id))
            ).scalars().first()
            if not parent:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent folder not found")
        folder.parent_folder_id = data.parent_folder_id

    await db.commit()
    await db.refresh(folder)
    return folder

@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Delete an empty folder"""
    folder = (
        await db.execute(select(Folder).where(Folder.id == id, Folder.org_id == current_user.org_id))
    ).scalars().first()
    if not folder:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found")

    has_children = (
        await db.execute(select(Folder).where(Folder.parent_folder_id == id))
    ).scalars().first() is not None
    has_documents = (
        await db.execute(select(Document).where(Document.folder_id == id))
    ).scalars().first() is not None

    if has_children or has_documents:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete folder with children or documents"
        )

    await db.delete(folder)
    await db.commit()
