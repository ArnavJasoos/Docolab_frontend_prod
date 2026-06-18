from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.database_models import Assignment, Folder, Document, Role, RolePermission


async def authorize(db: AsyncSession, user_id, permission: str, scope_type: str, scope_id) -> tuple[bool, str | None, str | None]:
    """Resolve a user's effective role on a scope and check it grants `permission`.

    Walks the scope hierarchy: document -> its folder -> parent folders, stopping
    at the first assignment found. Returns (has_permission, role_name, via_scope).
    """
    current_scope_type = scope_type
    current_scope_id = scope_id

    while current_scope_id is not None:
        result = await db.execute(
            select(Assignment).where(
                Assignment.user_id == user_id,
                Assignment.scope_type == current_scope_type,
                Assignment.scope_id == current_scope_id,
            )
        )
        assignment = result.scalars().first()

        if assignment:
            role = (
                await db.execute(select(Role).where(Role.id == assignment.role_id))
            ).scalars().first()
            if role:
                has_perm = (
                    await db.execute(
                        select(RolePermission).where(
                            RolePermission.role_id == role.id,
                            RolePermission.permission == permission,
                        )
                    )
                ).scalars().first() is not None

                via_scope_str = f"{current_scope_type}:{current_scope_id}"
                return has_perm, role.name, via_scope_str

        if current_scope_type == "document":
            doc = (
                await db.execute(select(Document).where(Document.id == current_scope_id))
            ).scalars().first()
            if doc:
                current_scope_type = "folder"
                current_scope_id = doc.folder_id
            else:
                break
        elif current_scope_type == "folder":
            folder = (
                await db.execute(select(Folder).where(Folder.id == current_scope_id))
            ).scalars().first()
            if folder and folder.parent_folder_id:
                current_scope_id = folder.parent_folder_id
            else:
                break
        else:
            break

    return False, None, None


async def require_permission(
    db: AsyncSession, user_id, permission: str, scope_type: str, scope_id
) -> tuple[str | None, str | None]:
    """RBAC guard: raise 403 unless `user_id` holds `permission` on the scope.

    This is the single choke-point every mutating endpoint calls before it
    changes state. Returns (resolved_role_name, via_scope) on success so the
    caller can log it. Reuses authorize()'s document -> folder -> parent walk,
    so a role granted on a folder is inherited by its documents, and a role
    granted directly on a document overrides the inherited one.
    """
    has_perm, role_name, via = await authorize(db, user_id, permission, scope_type, scope_id)
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Forbidden: requires '{permission}' on this {scope_type}",
        )
    return role_name, via
