import uuid
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Document, User, Folder
from app.schemas.document import DocumentCreate, DocumentResponse, DocumentListResponse, AuthorizeCheckResponse
from app.services.auth_service import authorize

router = APIRouter()

@router.post("", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
def create_document(data: DocumentCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    folder = db.query(Folder).filter(Folder.id == data.folder_id).first()
    if not folder:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder not found")

    doc_id = str(uuid.uuid4())
    doc = Document(
        id=doc_id,
        org_id=current_user.org_id,
        folder_id=data.folder_id,
        title=data.title,
        yjs_doc_key=doc_id,
        schema_version=1,
        status="working",
        current_version_no=0,
        offline_enabled=False,
        approval_policy_id=None,
        created_by=current_user.id
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc

@router.get("", response_model=DocumentListResponse)
def list_documents(folder_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    docs = db.query(Document).filter(Document.folder_id == folder_id).all()
    return {"documents": docs}

@router.get("/{id}/authorize-check", response_model=AuthorizeCheckResponse)
def check_authorization(id: str, permission: str = Query(...), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    doc = db.query(Document).filter(Document.id == id).first()
    if not doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
        
    allowed, resolved_role, via_scope = authorize(
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