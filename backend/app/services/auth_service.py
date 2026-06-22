from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.database_models import Assignment, Folder, Document, Role, RolePermission


async def resolve_role(db: AsyncSession, user_id, scope_type: str, scope_id) -> tuple[object | None, str | None, str | None]:
    """Resolve a user's EFFECTIVE role on a scope.

    Walks the scope hierarchy and returns the first assignment found:
      document -> its folder -> parent folders   (folders/documents)
      org      -> terminal (no walk)             (org-level grants)
    Returns (role_id, role_name, via_scope) or (None, None, None) if no role.
    This is the single place the scope-walk lives; authorize() builds on it.
    """
    current_scope_type = scope_type
    current_scope_id = scope_id

    while current_scope_id is not None:
        assignment = (
            await db.execute(
                select(Assignment).where(
                    Assignment.user_id == user_id,
                    Assignment.scope_type == current_scope_type,
                    Assignment.scope_id == current_scope_id,
                )
            )
        ).scalars().first()

        if assignment:
            role = (
                await db.execute(select(Role).where(Role.id == assignment.role_id))
            ).scalars().first()
            via = f"{current_scope_type}:{current_scope_id}"
            return (role.id if role else None, role.name if role else None, via)

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
                # Reached root folder — fall back to org scope as final check.
                # An org-scoped assignment is the ultimate authority for all
                # documents and folders belonging to that org.
                org_id = folder.org_id if folder else None
                if org_id is not None:
                    current_scope_type = "org"
                    current_scope_id = org_id
                else:
                    break
        else:
            # "org" (or any non-hierarchical scope) is terminal — no walk.
            break

    return (None, None, None)


async def authorize(db: AsyncSession, user_id, permission: str, scope_type: str, scope_id) -> tuple[bool, str | None, str | None]:
    """Does the user's effective role on the scope grant `permission`?

    Returns (has_permission, role_name, via_scope). A role on a folder is
    inherited by its documents; a role directly on a document overrides the
    inherited one (document scope is resolved first).
    """
    role_id, role_name, via = await resolve_role(db, user_id, scope_type, scope_id)
    if role_id is None:
        return False, None, None
    has_perm = (
        await db.execute(
            select(RolePermission).where(
                RolePermission.role_id == role_id,
                RolePermission.permission == permission,
            )
        )
    ).scalars().first() is not None
    return has_perm, role_name, via


async def require_permission(
    db: AsyncSession, user_id, permission: str, scope_type: str, scope_id
) -> tuple[str | None, str | None]:
    """RBAC guard: raise 403 unless `user_id` holds `permission` on the scope.

    The single choke-point every mutating endpoint calls before changing state.
    Returns (resolved_role_name, via_scope) on success (handy for audit meta).
    """
    has_perm, role_name, via = await authorize(db, user_id, permission, scope_type, scope_id)
    if not has_perm:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Forbidden: requires '{permission}' on this {scope_type}",
        )
    return role_name, via


async def is_org_admin(db: AsyncSession, user) -> bool:
    """True if the user holds an ORG-scoped role with can_manage_members.

    Org-admin is granted via an `assignments` row with scope_type="org",
    scope_id=org_id (seeded for the bootstrap admin; grantable by other admins).
    It is deliberately NOT inferred from folder/document ownership — because
    creator-owns gives every user `can_manage_members` somewhere, that would make
    everyone an admin. Org scope is the explicit, separate signal.
    """
    has_perm, _, _ = await authorize(db, user.id, "can_manage_members", "org", user.org_id)
    return has_perm
