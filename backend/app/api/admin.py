# =============================================================================
# app/api/admin.py  —  /api/admin/*  (Docolab Admin page backend)
#
# Every route here depends on require_org_admin: the caller must hold an
# ORG-scoped role with can_manage_members (see auth_service.is_org_admin). That
# single signal is what "admin" means throughout the app — it is NOT inferred
# from folder/document ownership. Because an org-scoped grant already resolves
# (via resolve_role's org fallback) to authority over EVERY document and folder
# in the org, these endpoints can operate org-wide without per-scope re-checks;
# they still constrain everything to the admin's own org for tenant isolation.
#
# This module is purely additive — it introduces no changes to the existing
# document/folder/assignment/user routes. It leans on the same tables those
# routes use (assignments, document_folders, users, documents), so anything the
# admin does here is visible to the normal-user surface immediately (e.g. a
# document-scoped assignment shows up in that user's "Shared with me").
# =============================================================================

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select, delete, or_, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.config import settings
from app.core.security import verify_password, create_access_token, get_password_hash
from app.api.deps import require_org_admin, require_super_admin
from app.models.database_models import (
    User, Document, Folder, Role, RolePermission, Assignment, DocumentFolder,
    AiModel, AiUsageEvent,
)
from app.schemas.auth import Token
from app.schemas.admin import (
    AdminLoginRequest, AdminUserItem, AdminUserListResponse, MembershipUpdateRequest,
    AdminUserCreate, ChangePasswordRequest,
    AdminDocItem, AdminDocListResponse,
    DocAccessEntry, DocAccessListResponse, DocAccessUpsertRequest,
    FolderCheckItem, DocFoldersResponse, SetDocFoldersRequest,
    SetAiModelRequest,
    AssignDocumentRequest, OkResponse,
    AiModelItem, AiModelListResponse, AiModelCreate, AiModelPatch,
    UsageByModelItem, UsageByModelResponse,
    UsageByDocumentItem, UsageByDocumentResponse,
    VALID_ROLE_NAMES,
)
from app.services.auth_service import is_org_admin, is_super_admin
from app.services.presence_service import is_online
from app.services.audit_service import record_audit, AuditAction
from app.services.token_service import issue_refresh_token, prune_user_tokens
from app.services import ai_model_service
from app.services.ask_ai.model_registry import ModelRegistry

router = APIRouter()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

async def _role_by_name(db: AsyncSession, org_id, name: str) -> Optional[Role]:
    return (
        await db.execute(select(Role).where(Role.org_id == org_id, Role.name == name))
    ).scalars().first()


async def _get_org_doc(db: AsyncSession, doc_id: str, org_id) -> Document:
    """Fetch a document within the admin's org or raise 404 (incl. bad UUID)."""
    try:
        uuid.UUID(str(doc_id))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    doc = (
        await db.execute(select(Document).where(Document.id == doc_id, Document.org_id == org_id))
    ).scalars().first()
    if not doc or doc.status == "deleted":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found")
    return doc


async def _get_org_user(db: AsyncSession, user_id: str, org_id) -> User:
    try:
        uuid.UUID(str(user_id))
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user = (
        await db.execute(select(User).where(User.id == user_id, User.org_id == org_id))
    ).scalars().first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


async def _org_admin_ids(db: AsyncSession, org_id) -> set:
    """User ids in the org that hold an ORG-scoped role granting can_manage_members
    (i.e. admin-panel access). Used to flag admins in the user list without an
    N+1 authorize() per row."""
    rows = (
        await db.execute(
            select(Assignment.user_id)
            .join(Role, Role.id == Assignment.role_id)
            .join(RolePermission, RolePermission.role_id == Role.id)
            .where(
                Assignment.scope_type == "org",
                Assignment.scope_id == org_id,
                RolePermission.permission == "can_manage_members",
            )
        )
    ).scalars().all()
    return set(rows)


def _user_item(u: User, *, is_admin: bool) -> AdminUserItem:
    """Build the API view of a user with the admin/super-admin flags resolved."""
    return AdminUserItem(
        id=u.id, email=u.email, display_name=u.display_name,
        avatar_color=u.avatar_color, status=u.status,
        online=is_online(u.last_seen_at), last_seen_at=u.last_seen_at,
        created_at=u.created_at, ai_model=u.ai_model,
        is_admin=is_admin, is_super_admin=is_super_admin(u),
    )


async def _upsert_doc_assignment(db: AsyncSession, admin: User, doc: Document, user_id, role_name: str):
    """Create-or-update the target user's DOCUMENT-scoped role assignment.

    This is the admin power behind requirements 2/9/13: set (or change) any
    user's role on any document — including the creator/owner. Writing a
    document-scoped assignment is exactly what surfaces the doc in that user's
    "Shared with me" list (requirement 10).
    """
    if role_name not in VALID_ROLE_NAMES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid role '{role_name}'")
    role = await _role_by_name(db, admin.org_id, role_name)
    if not role:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Role '{role_name}' not configured for org")

    target = await _get_org_user(db, str(user_id), admin.org_id)

    existing = (
        await db.execute(
            select(Assignment).where(
                Assignment.user_id == target.id,
                Assignment.scope_type == "document",
                Assignment.scope_id == doc.id,
            )
        )
    ).scalars().first()
    if existing:
        existing.role_id = role.id
    else:
        db.add(Assignment(
            org_id=admin.org_id,
            user_id=target.id,
            role_id=role.id,
            scope_type="document",
            scope_id=doc.id,
        ))
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.ROLE_CHANGE, target_type="assignment",
        target_id=None, document_id=doc.id,
        meta={"admin": True, "user_id": str(target.id), "role": role_name, "scope": "document"},
    )
    return target, role


# ---------------------------------------------------------------------------
# auth (requirement 7 — separate admin login)
# ---------------------------------------------------------------------------

@router.post("/login", response_model=Token)
async def admin_login(data: AdminLoginRequest, db: AsyncSession = Depends(get_db)):
    """Admin sign-in. Same credential check as the normal login, but rejects
    anyone who is not an org admin — the admin UI has its own entry point."""
    email = data.email.strip().lower()
    user = (
        await db.execute(select(User).where(func.lower(User.email) == email))
    ).scalars().first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    if user.status == "disabled":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user account")
    if not await is_org_admin(db, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator privileges required")

    token = create_access_token(subject=user.id)
    refresh_token = issue_refresh_token(db, user)
    await prune_user_tokens(db, user.id)
    record_audit(
        db, org_id=user.org_id, actor_id=user.id,
        action=AuditAction.LOGIN, target_type="user", target_id=user.id,
        meta={"admin": True},
    )
    await db.commit()
    await db.refresh(user)
    return {"user": user, "token": token, "refresh_token": refresh_token}


@router.get("/me", response_model=AdminUserItem)
async def admin_me(admin: User = Depends(require_org_admin)):
    """The signed-in admin's own record (confirms admin access for the UI). The
    is_super_admin flag gates the admin-account management surface in the UI."""
    return _user_item(admin, is_admin=True)


# ---------------------------------------------------------------------------
# users + presence (requirements 4, 5, 12)
# ---------------------------------------------------------------------------

@router.get("/users", response_model=AdminUserListResponse)
async def admin_list_users(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Every user in the org with email + online/offline status (derived from
    the presence heartbeat). Powers the Admin Users section."""
    users = (
        await db.execute(select(User).where(User.org_id == admin.org_id).order_by(User.created_at))
    ).scalars().all()
    admin_ids = await _org_admin_ids(db, admin.org_id)
    return AdminUserListResponse(users=[
        _user_item(u, is_admin=(u.id in admin_ids)) for u in users
    ])


@router.post("/users", response_model=AdminUserItem, status_code=status.HTTP_201_CREATED)
async def admin_create_user(
    data: AdminUserCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Requirement 4 (add side): the admin creates a new member in their org.
    Mirrors auth.signup — lowercased/unique email, hashed password, active
    status, and NO org-wide role (per-user isolation). The user can then be
    assigned to documents from here or the document panel."""
    email = data.email.strip().lower()
    if not data.display_name.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Display name is required")
    if len(data.password) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 8 characters")

    existing = (
        await db.execute(select(User).where(func.lower(User.email) == email))
    ).scalars().first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    user = User(
        org_id=admin.org_id,
        email=email,
        password_hash=get_password_hash(data.password),
        display_name=data.display_name.strip(),
        avatar_color=(data.avatar_color or "#7aa2f7"),
        status="active",
    )
    db.add(user)
    await db.flush()
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.USER_SIGNUP, target_type="user", target_id=user.id,
        meta={"admin": True, "created_email": user.email},
    )
    await db.commit()
    await db.refresh(user)
    return _user_item(user, is_admin=False)


# ---------------------------------------------------------------------------
# admin accounts (requirement 4 — super-admin only)
# ---------------------------------------------------------------------------

@router.get("/admins", response_model=AdminUserListResponse)
async def admin_list_admins(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Every admin account in the org (users holding an org-scoped admin role).
    Readable by any admin; only the super admin may create/delist them."""
    admin_ids = await _org_admin_ids(db, admin.org_id)
    if not admin_ids:
        return AdminUserListResponse(users=[])
    users = (
        await db.execute(
            select(User)
            .where(User.org_id == admin.org_id, User.id.in_(admin_ids))
            .order_by(User.created_at)
        )
    ).scalars().all()
    return AdminUserListResponse(users=[_user_item(u, is_admin=True) for u in users])


@router.post("/admins", response_model=AdminUserItem, status_code=status.HTTP_201_CREATED)
async def admin_create_admin(
    data: AdminUserCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
    """Requirement 4: the primary admin creates another admin account. The new
    user is granted an ORG-scoped `owner` role (the role carrying
    can_manage_members), which is exactly what unlocks the admin dashboard —
    then they can manage normal users, but cannot create/delist admins (that
    stays super-admin only) and cannot delist the primary admin."""
    email = data.email.strip().lower()
    if not data.display_name.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Display name is required")
    if len(data.password) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 8 characters")

    existing = (
        await db.execute(select(User).where(func.lower(User.email) == email))
    ).scalars().first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    owner_role = await _role_by_name(db, admin.org_id, "owner")
    if not owner_role:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Owner role not configured for org")

    user = User(
        org_id=admin.org_id,
        email=email,
        password_hash=get_password_hash(data.password),
        display_name=data.display_name.strip(),
        avatar_color=(data.avatar_color or "#7aa2f7"),
        status="active",
    )
    db.add(user)
    await db.flush()
    # Org-scoped admin grant — the explicit signal is_org_admin looks for.
    db.add(Assignment(
        org_id=admin.org_id, user_id=user.id, role_id=owner_role.id,
        scope_type="org", scope_id=admin.org_id,
    ))
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.USER_SIGNUP, target_type="user", target_id=user.id,
        meta={"admin": True, "created_admin": user.email},
    )
    await db.commit()
    await db.refresh(user)
    return _user_item(user, is_admin=True)


# ---------------------------------------------------------------------------
# self-service password change (requirement 3)
# ---------------------------------------------------------------------------

@router.post("/change-password", response_model=OkResponse)
async def admin_change_password(
    data: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Change the signed-in admin's own password. Verifies the current password
    and enforces a minimum length on the new one. The frontend confirms the new
    password was typed twice before calling."""
    if not verify_password(data.old_password, admin.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    if len(data.new_password) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New password must be at least 8 characters")
    if data.new_password == data.old_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New password must differ from the current one")

    admin.password_hash = get_password_hash(data.new_password)
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.USER_UPDATE, target_type="user", target_id=admin.id,
        meta={"admin": True, "password_changed": True},
    )
    await db.commit()
    return OkResponse(message="Password updated")


@router.patch("/users/{user_id}/membership", response_model=AdminUserItem)
async def admin_set_membership(
    user_id: str,
    data: MembershipUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """List (active) / delist (disabled) a user in the org. Delisting sets the
    account to 'disabled' so it can no longer log in (get_current_user rejects
    disabled users) — a reversible membership toggle rather than a hard delete."""
    target = await _get_org_user(db, user_id, admin.org_id)
    if str(target.id) == str(admin.id) and not data.active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delist yourself")

    # Delisting protections for admin accounts (requirement 4):
    #   - the primary/super admin can NEVER be delisted (by anyone).
    #   - delisting any other admin account is a super-admin-only power; a created
    #     admin may manage normal users but not remove fellow admins.
    if not data.active:
        target_is_admin = await is_org_admin(db, target)
        if is_super_admin(target):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="The primary administrator account cannot be delisted",
            )
        if target_is_admin and not is_super_admin(admin):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the primary administrator can delist an admin account",
            )

    new_status = "active" if data.active else "disabled"
    before = target.status
    target.status = new_status
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.USER_UPDATE, target_type="user", target_id=target.id,
        meta={"admin": True, "membership": {"before": before, "after": new_status}},
    )
    await db.commit()
    await db.refresh(target)
    return _user_item(target, is_admin=await is_org_admin(db, target))


@router.get("/users/{user_id}/documents", response_model=AdminDocListResponse)
async def admin_user_documents(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Documents a given user can access (created by them OR shared with them via
    a document-scoped assignment). Backs the click-a-user → see/assign flow."""
    target = await _get_org_user(db, user_id, admin.org_id)
    shared_ids = select(Assignment.scope_id).where(
        Assignment.user_id == target.id, Assignment.scope_type == "document",
    )
    docs = (
        await db.execute(
            select(Document).where(
                Document.org_id == admin.org_id,
                Document.status != "deleted",
                or_(Document.created_by == target.id, Document.id.in_(shared_ids)),
            )
        )
    ).scalars().all()
    # The user's explicit document-scoped role per doc (for the inline dropdown).
    # Docs they only created (no assignment) resolve to owner via creator-owns.
    role_rows = (
        await db.execute(
            select(Assignment.scope_id, Role.name)
            .join(Role, Role.id == Assignment.role_id)
            .where(Assignment.user_id == target.id, Assignment.scope_type == "document")
        )
    ).all()
    role_by_doc = {str(scope_id): name for scope_id, name in role_rows}
    for d in docs:
        if str(d.id) not in role_by_doc and d.created_by == target.id:
            role_by_doc[str(d.id)] = "owner"
    return await _docs_to_response(db, admin.org_id, docs, role_by_doc)


@router.post("/users/{user_id}/assign-document", response_model=OkResponse)
async def admin_assign_document_to_user(
    user_id: str,
    data: AssignDocumentRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Requirement 13: from the Users section, click a user and assign a document
    to them with a role (default Collaborator/editor). The document then appears
    in that user's 'Shared with me' (requirement 10)."""
    doc = await _get_org_doc(db, str(data.document_id), admin.org_id)
    target, role = await _upsert_doc_assignment(db, admin, doc, user_id, data.role)
    await db.commit()
    return OkResponse(message=f"Assigned '{doc.title}' to {target.display_name} as {role.name}")


# ---------------------------------------------------------------------------
# documents: org-wide list + search (requirements 1, 3)
# ---------------------------------------------------------------------------

async def _docs_to_response(
    db: AsyncSession, org_id, docs, role_by_doc: Optional[dict] = None,
) -> AdminDocListResponse:
    """Attach creator email/name to a batch of documents for the admin list.

    `role_by_doc` (keyed by str(document_id)) optionally supplies a specific
    user's role per document — used by the per-user documents endpoint so the
    UI can show/change that user's role inline.
    """
    creator_ids = {d.created_by for d in docs}
    creators = {}
    if creator_ids:
        rows = (
            await db.execute(select(User).where(User.id.in_(creator_ids)))
        ).scalars().all()
        creators = {u.id: u for u in rows}
    items = []
    for d in docs:
        c = creators.get(d.created_by)
        items.append(AdminDocItem(
            id=d.id, title=d.title, status=d.status, folder_id=d.folder_id,
            ai_model=d.ai_model, trashed=d.trashed, created_by=d.created_by,
            creator_email=c.email if c else None,
            creator_name=c.display_name if c else None,
            created_at=d.created_at, updated_at=d.updated_at,
            role_name=(role_by_doc.get(str(d.id)) if role_by_doc else None),
        ))
    return AdminDocListResponse(documents=items)


@router.get("/documents", response_model=AdminDocListResponse)
async def admin_list_documents(
    q: Optional[str] = Query(None, description="case-insensitive title search"),
    folder_id: Optional[str] = Query(None, description="restrict to one folder (primary OR extra placement)"),
    trashed: Optional[bool] = Query(None, description="None=all, true=recycle bin only, false=active only"),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Every document in the admin's org (requirement 1), with title search
    (requirement 3). Unlike the normal /documents list this is NOT filtered to
    created/shared — org admins see everything in their org."""
    query = select(Document).where(
        Document.org_id == admin.org_id,
        Document.status != "deleted",
    )
    if q:
        query = query.where(Document.title.ilike(f"%{q}%"))
    if trashed is not None:
        query = query.where(Document.trashed == bool(trashed))
    if folder_id is not None:
        try:
            uuid.UUID(folder_id)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid folder_id")
        # match primary location OR any extra placement in document_folders
        extra_doc_ids = select(DocumentFolder.document_id).where(DocumentFolder.folder_id == folder_id)
        query = query.where(or_(Document.folder_id == folder_id, Document.id.in_(extra_doc_ids)))
    docs = (await db.execute(query.order_by(Document.updated_at.desc()))).scalars().all()
    return await _docs_to_response(db, admin.org_id, docs)


# ---------------------------------------------------------------------------
# per-document access / roles (requirements 2, 8, 9, 13)
# ---------------------------------------------------------------------------

@router.get("/documents/{doc_id}/access", response_model=DocAccessListResponse)
async def admin_list_doc_access(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Who has an explicit role on this document. The creator is always shown
    (flagged is_creator) even though they normally also hold an owner
    assignment via creator-owns."""
    doc = await _get_org_doc(db, doc_id, admin.org_id)
    rows = (
        await db.execute(
            select(Assignment, Role, User)
            .join(Role, Role.id == Assignment.role_id)
            .join(User, User.id == Assignment.user_id)
            .where(Assignment.scope_type == "document", Assignment.scope_id == doc.id)
        )
    ).all()
    entries = []
    seen = set()
    for a, r, u in rows:
        seen.add(u.id)
        entries.append(DocAccessEntry(
            user_id=u.id, email=u.email, display_name=u.display_name,
            role_id=r.id, role_name=r.name, is_creator=(u.id == doc.created_by),
        ))
    if doc.created_by not in seen:
        creator = (await db.execute(select(User).where(User.id == doc.created_by))).scalars().first()
        if creator:
            entries.append(DocAccessEntry(
                user_id=creator.id, email=creator.email, display_name=creator.display_name,
                role_id=None, role_name=None, is_creator=True,
            ))
    return DocAccessListResponse(document_id=doc.id, entries=entries)


@router.put("/documents/{doc_id}/access", response_model=OkResponse)
async def admin_upsert_doc_access(
    doc_id: str,
    data: DocAccessUpsertRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Set (or change) a user's role on a document — including the creator/owner
    (requirement 2). Creates the assignment if absent (requirement 9/13)."""
    doc = await _get_org_doc(db, doc_id, admin.org_id)
    target, role = await _upsert_doc_assignment(db, admin, doc, data.user_id, data.role)
    await db.commit()
    return OkResponse(message=f"{target.display_name} is now {role.name} on '{doc.title}'")


@router.delete("/documents/{doc_id}/access/{user_id}", response_model=OkResponse)
async def admin_remove_doc_access(
    doc_id: str,
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Remove a user's document-scoped access (requirement 2/9). Drops the
    document-scoped assignment; the doc leaves that user's 'Shared with me'."""
    doc = await _get_org_doc(db, doc_id, admin.org_id)
    target = await _get_org_user(db, user_id, admin.org_id)
    existing = (
        await db.execute(
            select(Assignment).where(
                Assignment.user_id == target.id,
                Assignment.scope_type == "document",
                Assignment.scope_id == doc.id,
            )
        )
    ).scalars().first()
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User has no direct access to this document")
    await db.delete(existing)
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.ROLE_REVOKE, target_type="assignment", target_id=existing.id,
        document_id=doc.id,
        meta={"admin": True, "user_id": str(target.id), "scope": "document"},
    )
    await db.commit()
    return OkResponse(message=f"Removed {target.display_name} from '{doc.title}'")


# ---------------------------------------------------------------------------
# multi-folder placement (requirement 6)
# ---------------------------------------------------------------------------

@router.get("/documents/{doc_id}/folders", response_model=DocFoldersResponse)
async def admin_get_doc_folders(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """All org folders with a `checked` flag for the Folder(s) dropdown. Checked
    = the document's primary folder OR one of its extra placements."""
    doc = await _get_org_doc(db, doc_id, admin.org_id)
    folders = (
        await db.execute(select(Folder).where(Folder.org_id == admin.org_id).order_by(Folder.name))
    ).scalars().all()
    extra_ids = set((
        await db.execute(select(DocumentFolder.folder_id).where(DocumentFolder.document_id == doc.id))
    ).scalars().all())
    items = [
        FolderCheckItem(
            folder_id=f.id, name=f.name,
            checked=(f.id == doc.folder_id or f.id in extra_ids),
            is_primary=(f.id == doc.folder_id),
        )
        for f in folders
    ]
    return DocFoldersResponse(document_id=doc.id, primary_folder_id=doc.folder_id, folders=items)


@router.put("/documents/{doc_id}/folders", response_model=DocFoldersResponse)
async def admin_set_doc_folders(
    doc_id: str,
    data: SetDocFoldersRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Replace the document's EXTRA folder placements with the given set. The
    primary folder (documents.folder_id) is never removed here and is implied,
    so it is skipped if present in the payload. Every id must be a folder in the
    admin's org."""
    doc = await _get_org_doc(db, doc_id, admin.org_id)

    desired = {fid for fid in data.folder_ids if fid != doc.folder_id}
    if desired:
        valid = set((
            await db.execute(
                select(Folder.id).where(Folder.org_id == admin.org_id, Folder.id.in_(desired))
            )
        ).scalars().all())
        missing = desired - valid
        if missing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Folder(s) not found in org: {', '.join(str(m) for m in missing)}",
            )

    # Replace the set: drop existing extra placements, insert the desired ones.
    await db.execute(delete(DocumentFolder).where(DocumentFolder.document_id == doc.id))
    for fid in desired:
        db.add(DocumentFolder(document_id=doc.id, folder_id=fid, org_id=admin.org_id))
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.DOCUMENT_UPDATE, target_type="document", target_id=doc.id,
        document_id=doc.id,
        meta={"admin": True, "extra_folders": [str(f) for f in desired]},
    )
    await db.commit()
    return await admin_get_doc_folders(doc_id, db, admin)


# ---------------------------------------------------------------------------
# per-user AI model (requirement 1 — moved from per-document)
# ---------------------------------------------------------------------------

@router.put("/users/{user_id}/ai-model", response_model=AdminUserItem)
async def admin_set_user_ai_model(
    user_id: str,
    data: SetAiModelRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Assign which AI model this user's editor uses. The model_key must be an
    ENABLED entry in the org catalog (ai_models) — free-text is rejected so a
    user can't be pointed at an ungoverned/keyless model. AI resolution keys off
    the editing user's model (see app/api/ai.py)."""
    model = (data.ai_model or "").strip()
    if not model:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="ai_model must not be empty")
    target = await _get_org_user(db, user_id, admin.org_id)
    catalog = await ai_model_service.get_by_key(db, admin.org_id, model)
    if catalog is None or not catalog.enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"'{model}' is not an enabled model in this org's catalog",
        )
    before = target.ai_model
    target.ai_model = model
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.USER_UPDATE, target_type="user", target_id=target.id,
        meta={"admin": True, "ai_model": {"before": before, "after": model}},
    )
    await db.commit()
    await db.refresh(target)
    return _user_item(target, is_admin=await is_org_admin(db, target))


# ---------------------------------------------------------------------------
# AI model catalog administration (requirement 11 — the governed allow-list)
# ---------------------------------------------------------------------------

async def _clear_other_defaults(db: AsyncSession, org_id, keep_id) -> None:
    """Ensure at most one is_default per org."""
    rows = (
        await db.execute(
            select(AiModel).where(AiModel.org_id == org_id, AiModel.is_default == True)  # noqa: E712
        )
    ).scalars().all()
    for m in rows:
        if m.id != keep_id:
            m.is_default = False


@router.get("/ai/models", response_model=AiModelListResponse)
async def admin_list_ai_models(
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """The org's AI-model catalog (enabled + disabled). Drives the admin picker
    and the per-document model dropdown."""
    models = await ai_model_service.list_models(db, admin.org_id)
    return AiModelListResponse(models=[AiModelItem.model_validate(m) for m in models])


@router.post("/ai/models", response_model=AiModelItem, status_code=status.HTTP_201_CREATED)
async def admin_add_ai_model(
    data: AiModelCreate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Add a model to the org catalog. The model_key must be one the Ask-AI
    router is actually configured to call (a 'provider:model_key' from its
    config.yaml) — otherwise an admin could assign a user a model that fails on
    every request. Adding new models to config.yaml is an operator action; this
    only records that an existing one is permitted for this org."""
    model_key = data.model_key.strip()
    vendor = data.vendor.strip()
    if not model_key or not vendor or not data.display_name.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="vendor, model_key, display_name required")
    if model_key not in ModelRegistry.list_available_models():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"'{model_key}' is not a model the AI router is configured to call",
        )
    if await ai_model_service.get_by_key(db, admin.org_id, model_key):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Model '{model_key}' already in catalog")

    m = AiModel(
        org_id=admin.org_id, vendor=vendor, model_key=model_key,
        display_name=data.display_name.strip(),
        enabled=data.enabled, is_default=data.is_default and data.enabled,
    )
    db.add(m)
    await db.flush()
    if m.is_default:
        await _clear_other_defaults(db, admin.org_id, m.id)
    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.DOCUMENT_UPDATE, target_type="ai_model", target_id=m.id,
        meta={"admin": True, "add_model": model_key, "vendor": vendor, "enabled": m.enabled},
    )
    await db.commit()
    await db.refresh(m)
    return AiModelItem.model_validate(m)


@router.patch("/ai/models/{model_id}", response_model=AiModelItem)
async def admin_update_ai_model(
    model_id: str,
    data: AiModelPatch,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Enable/disable, rename, or set-default a catalog model. Setting default
    implies enabled and clears any other default. Disabling a model that a
    document still points at is safe — the resolver falls back to the org
    default."""
    try:
        uuid.UUID(model_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Model not found")
    m = (
        await db.execute(select(AiModel).where(AiModel.id == model_id, AiModel.org_id == admin.org_id))
    ).scalars().first()
    if not m:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Model not found")

    if data.display_name is not None:
        m.display_name = data.display_name.strip() or m.display_name
    if data.enabled is not None:
        m.enabled = data.enabled
        if not data.enabled:
            m.is_default = False  # a disabled model cannot be the default
    if data.is_default is not None and data.is_default:
        m.enabled = True
        m.is_default = True
        await db.flush()
        await _clear_other_defaults(db, admin.org_id, m.id)
    elif data.is_default is False:
        m.is_default = False

    record_audit(
        db, org_id=admin.org_id, actor_id=admin.id,
        action=AuditAction.DOCUMENT_UPDATE, target_type="ai_model", target_id=m.id,
        meta={"admin": True, "update_model": m.model_key,
              "enabled": m.enabled, "is_default": m.is_default},
    )
    await db.commit()
    await db.refresh(m)
    return AiModelItem.model_validate(m)


# ---------------------------------------------------------------------------
# AI usage metering — the Admin "Model Usage" section (Phase 4)
# Tokens-only. `days` optionally restricts to a trailing window.
# ---------------------------------------------------------------------------

def _since(days: Optional[int]):
    if not days or days <= 0:
        return None
    return datetime.now(timezone.utc) - timedelta(days=days)


@router.get("/ai/usage/by-model", response_model=UsageByModelResponse)
async def admin_usage_by_model(
    days: Optional[int] = Query(None, description="trailing window in days; omit for all-time"),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Token totals per model for the org — feeds the usage-% pie and the
    per-model token list. `pct` is each model's share of total tokens."""
    since = _since(days)
    conds = [AiUsageEvent.org_id == admin.org_id]
    if since is not None:
        conds.append(AiUsageEvent.created_at >= since)

    rows = (
        await db.execute(
            select(
                AiUsageEvent.vendor,
                AiUsageEvent.model_key,
                func.coalesce(func.sum(AiUsageEvent.input_tokens), 0),
                func.coalesce(func.sum(AiUsageEvent.output_tokens), 0),
                func.coalesce(func.sum(AiUsageEvent.total_tokens), 0),
                func.count(AiUsageEvent.id),
            )
            .where(*conds)
            .group_by(AiUsageEvent.vendor, AiUsageEvent.model_key)
        )
    ).all()

    # Resolve display names from the current catalog (a model may have been
    # removed; then display_name is None but usage still counts).
    names = {
        m.model_key: m.display_name
        for m in await ai_model_service.list_models(db, admin.org_id)
    }
    grand_total = sum(r[4] for r in rows) or 0
    items = [
        UsageByModelItem(
            vendor=vendor, model_key=model_key, display_name=names.get(model_key),
            input_tokens=int(inp), output_tokens=int(out), total_tokens=int(tot),
            call_count=int(cnt),
            pct=round((int(tot) / grand_total * 100.0), 2) if grand_total else 0.0,
        )
        for (vendor, model_key, inp, out, tot, cnt) in rows
    ]
    items.sort(key=lambda i: i.total_tokens, reverse=True)
    return UsageByModelResponse(total_tokens=int(grand_total), models=items)


@router.get("/ai/usage/by-document", response_model=UsageByDocumentResponse)
async def admin_usage_by_document(
    limit: int = Query(5, ge=1, le=100, description="top-N documents by token usage"),
    days: Optional[int] = Query(None, description="trailing window in days; omit for all-time"),
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_org_admin),
):
    """Top-N documents by token usage (descending) — feeds the comparison bar
    chart. Orphaned usage (document deleted) is bucketed under a null id."""
    since = _since(days)
    conds = [AiUsageEvent.org_id == admin.org_id]
    if since is not None:
        conds.append(AiUsageEvent.created_at >= since)

    rows = (
        await db.execute(
            select(
                AiUsageEvent.document_id,
                func.coalesce(func.sum(AiUsageEvent.input_tokens), 0),
                func.coalesce(func.sum(AiUsageEvent.output_tokens), 0),
                func.coalesce(func.sum(AiUsageEvent.total_tokens), 0),
                func.count(AiUsageEvent.id),
            )
            .where(*conds)
            .group_by(AiUsageEvent.document_id)
            .order_by(func.coalesce(func.sum(AiUsageEvent.total_tokens), 0).desc())
            .limit(limit)
        )
    ).all()

    doc_ids = [r[0] for r in rows if r[0] is not None]
    titles = {}
    if doc_ids:
        drows = (await db.execute(select(Document.id, Document.title).where(Document.id.in_(doc_ids)))).all()
        titles = {d_id: title for d_id, title in drows}
    items = [
        UsageByDocumentItem(
            document_id=document_id,
            title=titles.get(document_id) if document_id else None,
            input_tokens=int(inp), output_tokens=int(out), total_tokens=int(tot),
            call_count=int(cnt),
        )
        for (document_id, inp, out, tot, cnt) in rows
    ]
    return UsageByDocumentResponse(documents=items)
