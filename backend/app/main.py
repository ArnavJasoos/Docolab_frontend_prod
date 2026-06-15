from fastapi import FastAPI
from app.core.config import settings
from app.core.database import Base, engine, SessionLocal
from app.models.database_models import Role, RolePermission, User, Assignment
from app.core.security import get_password_hash
from app.api import auth, roles, folders, assignments, documents

app = FastAPI(title=settings.PROJECT_NAME)

# Mount Routers (using flat routes under app.api)
app.include_router(auth.router, prefix=f"{settings.API_STR}/auth", tags=["Authentication"])
app.include_router(roles.router, prefix=f"{settings.API_STR}/roles", tags=["Roles"])
app.include_router(folders.router, prefix=f"{settings.API_STR}/folders", tags=["Folders"])
app.include_router(assignments.router, prefix=f"{settings.API_STR}/assignments", tags=["Assignments"])
app.include_router(documents.router, prefix=f"{settings.API_STR}/documents", tags=["Documents"])

@app.on_event("startup")
def startup_event():
    Base.metadata.create_all(bind=engine)
    
    db = SessionLocal()
    try:
        # Seed Roles
        if db.query(Role).first() is None:
            owner = Role(id="role-owner", name="owner")
            editor = Role(id="role-editor", name="editor")
            viewer = Role(id="role-viewer", name="viewer")
            db.add_all([owner, editor, viewer])
            db.commit()

            # Seed Permissions
            owner_perms = [
                "can_edit_direct", "can_suggest", "can_resolve_suggestion",
                "can_submit_for_approval", "can_give_final_approval",
                "can_approve_level", "can_manage_approval_policy",
                "can_view_history", "can_manage_members"
            ]
            editor_perms = ["can_edit_direct", "can_suggest", "can_view_history"]
            
            for p in owner_perms:
                db.add(RolePermission(role_id=owner.id, permission=p))
            for p in editor_perms:
                db.add(RolePermission(role_id=editor.id, permission=p))
                
            db.commit()
            
        # Seed Admin User
        if db.query(User).filter(User.email == "admin@acme.com").first() is None:
            admin_user = User(
                id="user-admin-id",
                org_id="org-acme-id",
                email="admin@acme.com",
                password_hash=get_password_hash("adminsecret"),
                display_name="Admin User",
                status="active"
            )
            db.add(admin_user)
            db.commit()

            # Seed bootstrap role assignment
            root_assignment = Assignment(
                id="assignment-admin-root",
                org_id="org-acme-id",
                user_id=admin_user.id,
                role_id="role-owner",
                scope_type="folder",
                scope_id="root-folder-id"
            )
            db.add(root_assignment)
            db.commit()

    finally:
        db.close()