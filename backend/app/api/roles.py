from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Role, RolePermission
from app.schemas.role import RoleListResponse, RoleResponse

router = APIRouter()

@router.get("", response_model=RoleListResponse)
def list_roles(db: Session = Depends(get_db), current_user = Depends(get_current_user)):
    roles = db.query(Role).all()
    roles_output = []
    for role in roles:
        perms = db.query(RolePermission).filter(RolePermission.role_id == role.id).all()
        roles_output.append(
            RoleResponse(
                id=role.id,
                name=role.name,
                permissions=[p.permission for p in perms]
            )
        )
    return {"roles": roles_output}