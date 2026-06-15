# app/main.py
from fastapi import FastAPI
from sqlalchemy import select  # async queries
from app.core.config import settings
from app.core.database import Base, engine, SessionLocal
from app.models.database_models import Role, RolePermission, User, Assignment, Folder
from app.core.security import get_password_hash
from app.api import auth, roles, folders, assignments, documents, users, versions, notifications, ai, export
# Person A (collaboration cluster): suggestions, comments, recommendations, audit
from app.api import suggestions, comments, recommendations, audit
# Ownership transfer (assignment-management helper, document-scoped)
from app.api import ownership

app = FastAPI(title=settings.PROJECT_NAME)

# Mount Routers (using flat routes under app.api)
app.include_router(auth.router, prefix=f"{settings.API_STR}/auth", tags=["Authentication"])
app.include_router(roles.router, prefix=f"{settings.API_STR}/roles", tags=["Roles"])
app.include_router(folders.router, prefix=f"{settings.API_STR}/folders", tags=["Folders"])
app.include_router(assignments.router, prefix=f"{settings.API_STR}/assignments", tags=["Assignments"])
app.include_router(documents.router, prefix=f"{settings.API_STR}/documents", tags=["Documents"])
app.include_router(users.router, prefix=f"{settings.API_STR}/users", tags=["Users"])
app.include_router(versions.router, prefix=f"{settings.API_STR}/versions", tags=["Versioning & Approval"])
app.include_router(notifications.router, prefix=f"{settings.API_STR}/notifications", tags=["Notifications"])
app.include_router(ai.router, prefix=f"{settings.API_STR}/ai", tags=["AI Suggestions"])
app.include_router(export.router, prefix=f"{settings.API_STR}/export", tags=["Export"])

# Person A (collaboration cluster). These routers carry the full resource path
# on each decorator (e.g. /documents/{id}/suggestions), so they mount at the
# bare API prefix to produce the canonical URLs from the architecture doc.
app.include_router(suggestions.router, prefix=settings.API_STR, tags=["Suggestions"])
app.include_router(comments.router, prefix=settings.API_STR, tags=["Comments"])
app.include_router(recommendations.router, prefix=settings.API_STR, tags=["Recommendations"])
app.include_router(audit.router, prefix=settings.API_STR, tags=["Audit"])
app.include_router(ownership.router, prefix=settings.API_STR, tags=["Ownership"])


# Role -> permission seed set for the single v1 org.
ROLE_PERMISSIONS = {
    "owner": [
        "can_edit_direct", "can_suggest", "can_resolve_suggestion",
        "can_submit_for_approval", "can_give_final_approval",
        "can_approve_level", "can_manage_approval_policy",
        "can_view_history", "can_manage_members",
    ],
    "approver": [
        "can_suggest", "can_resolve_suggestion", "can_submit_for_approval",
        "can_give_final_approval", "can_approve_level", "can_view_history",
    ],
    "editor": ["can_edit_direct", "can_suggest", "can_view_history"],
    "suggester": ["can_suggest", "can_view_history"],
    "viewer": ["can_view_history"],
}


@app.on_event("startup")
async def startup_event():
    # 1. Create tables asynchronously
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # 2. Seed the single v1 org: roles + permissions, then an admin owner and a
    #    root folder. Guarded by existence checks so it runs only once.
    org_id = settings.DEFAULT_ORG_ID
    async with SessionLocal() as db:
        try:
            # Seed roles (idempotent: only if this org has none yet)
            existing_role = (
                await db.execute(select(Role).where(Role.org_id == org_id))
            ).scalars().first()
            if existing_role is None:
                for name, perms in ROLE_PERMISSIONS.items():
                    role = Role(org_id=org_id, name=name)
                    db.add(role)
                    await db.flush()
                    for p in perms:
                        db.add(RolePermission(role_id=role.id, permission=p))
                await db.commit()

            # Seed the first owner + a real root folder
            admin = (
                await db.execute(select(User).where(User.email == "admin@acme.com"))
            ).scalars().first()
            if admin is None:
                admin = User(
                    org_id=org_id,
                    email="admin@acme.com",
                    password_hash=get_password_hash("adminsecret"),
                    display_name="Admin User",
                    status="active",
                )
                db.add(admin)
                await db.flush()

                root = Folder(org_id=org_id, name="Workspace", created_by=admin.id)
                db.add(root)
                await db.flush()

                owner_role = (
                    await db.execute(
                        select(Role).where(Role.org_id == org_id, Role.name == "owner")
                    )
                ).scalars().first()
                if owner_role:
                    db.add(Assignment(
                        org_id=org_id,
                        user_id=admin.id,
                        role_id=owner_role.id,
                        scope_type="folder",
                        scope_id=root.id,
                    ))
                await db.commit()
        except Exception as e:
            await db.rollback()
            raise e
