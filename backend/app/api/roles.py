from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_db
from app.api.deps import get_current_user
from app.models.database_models import Role, RolePermission
from app.schemas.role import RoleListResponse, RoleResponse

router = APIRouter()

@router.get("", response_model=RoleListResponse)
async def list_roles(db: AsyncSession = Depends(get_db), current_user = Depends(get_current_user)):
    roles = (await db.execute(select(Role))).scalars().all()
    roles_output = []
    for role in roles:
        perms = (
            await db.execute(select(RolePermission).where(RolePermission.role_id == role.id))
        ).scalars().all()
        roles_output.append(
            RoleResponse(
                id=role.id,
                name=role.name,
                permissions=[p.permission for p in perms]
            )
        )
    return {"roles": roles_output}
