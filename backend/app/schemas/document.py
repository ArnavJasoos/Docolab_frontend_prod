from pydantic import BaseModel

class DocumentCreate(BaseModel):
    folder_id: str
    title: str

class DocumentResponse(BaseModel):
    id: str
    folder_id: str
    title: str
    status: str
    current_version_no: int
    yjs_doc_key: str

    class Config:
        from_attributes = True

class DocumentListItem(BaseModel):
    id: str
    title: str
    status: str
    current_version_no: int

    class Config:
        from_attributes = True

class DocumentListResponse(BaseModel):
    documents: list[DocumentListItem]

class AuthorizeCheckResponse(BaseModel):
    allowed: bool
    resolved_role: str | None
    via_scope: str | None