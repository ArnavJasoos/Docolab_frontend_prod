from sqlalchemy.orm import Session
from app.models.database_models import Assignment, Folder, Document, Role, RolePermission

def authorize(db: Session, user_id: str, permission: str, scope_type: str, scope_id: str) -> tuple[bool, str | None, str | None]:
    current_scope_type = scope_type
    current_scope_id = scope_id

    while current_scope_id is not None:
        assignment = db.query(Assignment).filter(
            Assignment.user_id == user_id,
            Assignment.scope_type == current_scope_type,
            Assignment.scope_id == current_scope_id
        ).first()

        if assignment:
            role = db.query(Role).filter(Role.id == assignment.role_id).first()
            if role:
                has_perm = db.query(RolePermission).filter(
                    RolePermission.role_id == role.id,
                    RolePermission.permission == permission
                ).first() is not None
                
                via_scope_str = f"{current_scope_type}:{current_scope_id}"
                return has_perm, role.name, via_scope_str

        if current_scope_type == "document":
            doc = db.query(Document).filter(Document.id == current_scope_id).first()
            if doc:
                current_scope_type = "folder"
                current_scope_id = doc.folder_id
            else:
                break
        elif current_scope_type == "folder":
            folder = db.query(Folder).filter(Folder.id == current_scope_id).first()
            if folder and folder.parent_folder_id:
                current_scope_id = folder.parent_folder_id
            else:
                break
        else:
            break

    return False, None, None