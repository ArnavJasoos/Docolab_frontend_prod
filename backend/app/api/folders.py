import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Folder, User
from app.schemas.folder import FolderCreate, FolderResponse

router = APIRouter()

@router.post("", response_model=FolderResponse, status_code=status.HTTP_201_CREATED)
def create_folder(data: FolderCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if data.parent_folder_id:
        parent = db.query(Folder).filter(Folder.id == data.parent_folder_id).first()
        if not parent:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parent folder not found")

    folder = Folder(
        id=str(uuid.uuid4()),
        org_id=current_user.org_id,
        parent_folder_id=data.parent_folder_id,
        name=data.name,
        created_by=current_user.id
    )
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return folder