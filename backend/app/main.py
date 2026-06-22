# app/main.py
from pathlib import Path

from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select  # async queries
from app.core.config import settings
from app.core.database import engine, SessionLocal
from app.models.database_models import Role, RolePermission, User, Assignment, Folder
from app.core.security import get_password_hash
from app.api import auth, roles, folders, assignments, documents, users, versions, notifications, ai, export
# Person A (collaboration cluster): suggestions, comments, recommendations, audit
from app.api import suggestions, comments, recommendations, audit
# Ownership transfer (assignment-management helper, document-scoped)
from app.api import ownership
# Governance: dynamic approval policies (chains)
from app.api import approval_policies

app = FastAPI(title=settings.PROJECT_NAME)

# ---------------------------------------------------------------------------
# CORS middleware
# ---------------------------------------------------------------------------
# Browsers block a web page served from one origin (e.g. the frontend at
# http://localhost:3000) from calling an API on a different origin (this
# backend at http://localhost:8000) UNLESS the API explicitly allows that
# origin. This middleware sends the Access-Control-Allow-* headers that tell
# the browser the frontend origin is permitted (incl. preflight OPTIONS).
# Allowed origins come from settings.CORS_ORIGINS (override via env in prod).
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,            # allow cookies / Authorization header
    allow_methods=["*"],               # GET, POST, PATCH, DELETE, OPTIONS, …
    allow_headers=["*"],               # incl. Authorization, Content-Type
)

# Mount Routers (using flat routes under app.api)
app.include_router(auth.router, prefix=f"{settings.API_STR}/auth", tags=["Authentication"])
app.include_router(roles.router, prefix=f"{settings.API_STR}/roles", tags=["Roles"])
app.include_router(folders.router, prefix=f"{settings.API_STR}/folders", tags=["Folders"])
app.include_router(assignments.router, prefix=f"{settings.API_STR}/assignments", tags=["Assignments"])
app.include_router(documents.router, prefix=f"{settings.API_STR}/documents", tags=["Documents"])
app.include_router(users.router, prefix=f"{settings.API_STR}/users", tags=["Users"])
# versions / ai / export routers carry the full resource path on each
# decorator (e.g. /documents/{id}/versions, /documents/{id}/ai/suggest,
# /documents/{id}/export), so they mount at the bare API prefix to produce
# the canonical URLs from the architecture doc — NOT under a sub-prefix
# (which would double-prefix to /api/versions/documents/{id}/versions).
# notifications uses relative paths (""/{id}/read/read-all), so it keeps
# its own /notifications prefix.
app.include_router(versions.router, prefix=settings.API_STR, tags=["Versioning & Approval"])
app.include_router(notifications.router, prefix=f"{settings.API_STR}/notifications", tags=["Notifications"])
app.include_router(ai.router, prefix=settings.API_STR, tags=["AI Suggestions"])
app.include_router(export.router, prefix=settings.API_STR, tags=["Export"])

# Person A (collaboration cluster). These routers carry the full resource path
# on each decorator (e.g. /documents/{id}/suggestions), so they mount at the
# bare API prefix to produce the canonical URLs from the architecture doc.
app.include_router(suggestions.router, prefix=settings.API_STR, tags=["Suggestions"])
app.include_router(comments.router, prefix=settings.API_STR, tags=["Comments"])
app.include_router(recommendations.router, prefix=settings.API_STR, tags=["Recommendations"])
app.include_router(audit.router, prefix=settings.API_STR, tags=["Audit"])
app.include_router(ownership.router, prefix=settings.API_STR, tags=["Ownership"])
app.include_router(approval_policies.router, prefix=settings.API_STR, tags=["Approval Policies"])


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


BACKEND_DIR = Path(__file__).resolve().parents[1]   # .../backend


def _run_alembic_upgrade(sync_connection):
    """Run `alembic upgrade head` using the app's own (sync-wrapped) connection.

    Alembic is the SINGLE source of truth for schema — we no longer call
    Base.metadata.create_all (which never ALTERs existing tables and silently
    drifts from the migrations). env.py picks up this injected connection so
    migrations run inside the app's event loop (no nested asyncio.run)."""
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.attributes["connection"] = sync_connection
    command.upgrade(cfg, "head")


@app.on_event("startup")
async def startup_event():
    # 1. Bring the schema to head via Alembic (creates tables on a fresh DB,
    #    applies pending migrations on an existing one). Set AUTO_MIGRATE=0 to
    #    manage migrations manually (`alembic upgrade head`).
    if settings.AUTO_MIGRATE:
        async with engine.begin() as conn:
            await conn.run_sync(_run_alembic_upgrade)

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
                    # Org-scoped owner assignment => the admin is the org admin
                    # (can manage members org-wide, manage approval policies,
                    # and read the org-wide audit log).
                    db.add(Assignment(
                        org_id=org_id,
                        user_id=admin.id,
                        role_id=owner_role.id,
                        scope_type="org",
                        scope_id=org_id,
                    ))
                await db.commit()
        except Exception as e:
            await db.rollback()
            raise e
