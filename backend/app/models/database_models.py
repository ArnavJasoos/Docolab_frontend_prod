# =============================================================================
# app/models/database_models.py
# SQLAlchemy models for the Collaborative Documentation Platform (PLATE).
#
# These are the Python equivalent of db/schema.sql — same 18 tables, same
# columns, same relationships. Alembic reads these classes and generates the
# actual CREATE TABLE SQL for Postgres.
#
# DESIGN RULES (from the spec):
#   - Postgres stores metadata, state, and pointers ONLY.
#   - Live document content lives in Yjs/Hocuspocus (yjs_doc_key).
#   - Approved/submitted blobs live in S3 (s3_key).
#   - Rows here only point at those systems.
# =============================================================================

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Index, Integer,
    Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import BYTEA, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _uuid() -> uuid.UUID:
    """Default factory for UUID primary keys."""
    return uuid.uuid4()


# =============================================================================
# GROUP A — Identity & access
# =============================================================================

class User(Base):
    """
    Who can log in. Never hard-deleted — disable via status instead.
    Nearly every other table has a FK back to this one.
    """
    __tablename__ = "users"

    id:            Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:        Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # email stored as lowercase text; unique index below enforces case-insensitive uniqueness.
    # (citext extension gives this automatically if available; lower() index is the fallback.)
    email:         Mapped[str]       = mapped_column(Text, nullable=False)
    password_hash: Mapped[str]       = mapped_column(Text, nullable=False)
    display_name:  Mapped[str]       = mapped_column(Text, nullable=False)
    avatar_color:  Mapped[Optional[str]] = mapped_column(Text)
    status:        Mapped[str]       = mapped_column(Text, nullable=False, server_default="active")
    # AI model this user's editor should use, resolved against the org catalog
    # (ai_models). Per-USER assignment (admin-managed) — replaces the old
    # per-document choice. Holds the Ask-AI router's 'provider:model_key'
    # identifier (e.g. 'groq:llama_70b'). Empty = the admin never chose one, so
    # the resolver falls back to the org default — as it also does when the
    # value is unknown or has been disabled.
    ai_model:      Mapped[str]       = mapped_column(Text, nullable=False, server_default="")
    # PRESENCE: last time this user pinged the heartbeat endpoint. NULL = never
    # seen. "online" is a derived value (last_seen_at within a short window) —
    # computed in the presence service, not stored, so it can't go stale.
    last_seen_at:  Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at:    Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:    Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Relationships (back-populated from child tables)
    assignments:             Mapped[list["Assignment"]]           = relationship(back_populates="user")
    created_folders:         Mapped[list["Folder"]]               = relationship(back_populates="created_by_user", foreign_keys="Folder.created_by")
    created_documents:       Mapped[list["Document"]]             = relationship(back_populates="created_by_user", foreign_keys="Document.created_by")
    suggestions_authored:    Mapped[list["Suggestion"]]           = relationship(back_populates="author", foreign_keys="Suggestion.author_id")
    suggestions_resolved:    Mapped[list["Suggestion"]]           = relationship(back_populates="resolver", foreign_keys="Suggestion.resolved_by")
    comments:                Mapped[list["Comment"]]              = relationship(back_populates="author")
    edit_attributions:       Mapped[list["EditAttribution"]]      = relationship(back_populates="author")
    notifications:           Mapped[list["Notification"]]         = relationship(back_populates="user")
    versions_created:        Mapped[list["Version"]]              = relationship(back_populates="created_by_user")
    approval_markers_by:     Mapped[list["ApprovalMarker"]]       = relationship(back_populates="approver", foreign_keys="ApprovalMarker.approved_by")
    approval_policies:       Mapped[list["ApprovalPolicy"]]       = relationship(back_populates="created_by_user")
    approval_step_events:    Mapped[list["ApprovalStepEvent"]]    = relationship(back_populates="actor")
    recommendations:         Mapped[list["Recommendation"]]       = relationship(back_populates="author", foreign_keys="Recommendation.author_id")
    recommendation_responses:Mapped[list["RecommendationResponse"]] = relationship(back_populates="author")
    audit_logs:              Mapped[list["AuditLog"]]             = relationship(back_populates="actor")

    __table_args__ = (
        # Case-insensitive unique email (mirrors citext UNIQUE in schema.sql)
        Index("uq_users_email_lower", func.lower(email), unique=True),
        Index("idx_users_org", "org_id"),
    )


class Role(Base):
    """
    The fixed role set: owner / approver / editor / viewer.
    UNIQUE (org_id, name) makes seed data idempotent.
    """
    __tablename__ = "roles"

    id:          Mapped[uuid.UUID]   = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:      Mapped[uuid.UUID]   = mapped_column(UUID(as_uuid=True), nullable=False)
    name:        Mapped[str]         = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    created_at:  Mapped[datetime]    = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:  Mapped[datetime]    = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    permissions: Mapped[list["RolePermission"]] = relationship(back_populates="role", cascade="all, delete-orphan")
    assignments: Mapped[list["Assignment"]]     = relationship(back_populates="role")
    policy_steps:Mapped[list["ApprovalPolicyStep"]] = relationship(back_populates="required_role")

    __table_args__ = (
        UniqueConstraint("org_id", "name", name="uq_roles_org_name"),
    )


class RolePermission(Base):
    """
    A role IS a set of permission strings. Each row is one permission.
    Composite PK means no duplicates and no surrogate key needed.
    """
    __tablename__ = "role_permissions"

    role_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)
    permission: Mapped[str]       = mapped_column(Text, primary_key=True)

    role: Mapped["Role"] = relationship(back_populates="permissions")


class Assignment(Base):
    """
    Scoped role grants — a user has a role for a specific folder or document.
    UNIQUE (user_id, scope_type, scope_id) prevents duplicate grants.
    """
    __tablename__ = "assignments"

    id:         Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:     Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    user_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    role_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roles.id"), nullable=False)
    scope_type: Mapped[str]       = mapped_column(Text, nullable=False)   # "folder" or "document"
    scope_id:   Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    user: Mapped["User"] = relationship(back_populates="assignments")
    role: Mapped["Role"] = relationship(back_populates="assignments")

    __table_args__ = (
        UniqueConstraint("user_id", "scope_type", "scope_id", name="uq_assignments_user_scope"),
        Index("idx_assignments_user", "user_id"),
    )


# =============================================================================
# GROUP B — Content organisation
# =============================================================================

class Folder(Base):
    """
    Nestable folders within an org. parent_folder_id = NULL means root.
    Self-referencing FK creates the tree structure.
    """
    __tablename__ = "folders"

    id:               Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:           Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), nullable=False)
    parent_folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id"))
    name:             Mapped[str]              = mapped_column(Text, nullable=False)
    created_by:       Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at:       Mapped[datetime]         = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:       Mapped[datetime]         = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    # Self-referencing relationship (tree of folders)
    parent:    Mapped[Optional["Folder"]] = relationship("Folder", back_populates="children", remote_side="Folder.id")
    children:  Mapped[list["Folder"]]    = relationship("Folder", back_populates="parent")
    documents: Mapped[list["Document"]]  = relationship(back_populates="folder")
    created_by_user: Mapped["User"]      = relationship(back_populates="created_folders", foreign_keys=[created_by])

    __table_args__ = (
        Index("idx_folders_parent", "parent_folder_id"),
    )


class Document(Base):
    """
    The hinge of the whole schema. Every governance table points here.
    yjs_doc_key bridges to Yjs/Hocuspocus live content.
    approval_policy_id = NULL means the original single-owner gate.
    """
    __tablename__ = "documents"

    id:                 Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:             Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), nullable=False)
    folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(
            UUID(as_uuid=True), 
            ForeignKey("folders.id"), 
            nullable=True  # <--- CHANGE THIS
        )
    title:              Mapped[str]              = mapped_column(Text, nullable=False)
    yjs_doc_key:        Mapped[str]              = mapped_column(Text, nullable=False)
    schema_version:     Mapped[int]              = mapped_column(Integer, nullable=False, server_default="1")
    status:             Mapped[str]              = mapped_column(Text, nullable=False, server_default="working")
    current_version_no: Mapped[int]              = mapped_column(Integer, nullable=False, server_default="0")
    offline_enabled:    Mapped[bool]             = mapped_column(Boolean, nullable=False, server_default="false")
    # Recycle bin (reversible). `trashed` is the soft-move flag; `trashed_at`
    # records when, so a future job can auto-purge old trash. Permanent removal
    # is a separate, terminal state (status="deleted") set by DELETE.
    trashed:            Mapped[bool]             = mapped_column(Boolean, nullable=False, server_default="false")
    trashed_at:         Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # NOTE: there is intentionally no `starred` column — bookmarks are PERSONAL
    # (per-user) and live in the document_stars table (see DocumentStar).
    yjs_state:          Mapped[Optional[bytes]]  = mapped_column(BYTEA, nullable=True)
    # IDLE-tier storage: a single, OVERWRITTEN (never appended) snapshot of the
    # last-known-good content, refreshed on explicit save (Ctrl+S) and on
    # leaving the document. Distinct from `versions` (permanent/append-only)
    # so casual editing never bloats version history. NULL until first save.
    content_snapshot:   Mapped[Optional[list]]   = mapped_column(JSONB, nullable=True)
    # LEGACY: the model choice is per-USER now (users.ai_model), which is what
    # the Ask-AI path resolves. Retained only so existing rows and the admin
    # document list keep their shape; nothing reads it to pick a model.
    ai_model:           Mapped[str]              = mapped_column(Text, nullable=False, server_default="")
    approval_policy_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("approval_policies.id"))
    created_by:         Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at:         Mapped[datetime]         = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:         Mapped[datetime]         = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    folder:           Mapped["Folder"]               = relationship(back_populates="documents")
    created_by_user:  Mapped["User"]                 = relationship(back_populates="created_documents", foreign_keys=[created_by])
    approval_policy:  Mapped[Optional["ApprovalPolicy"]] = relationship(back_populates="documents")
    suggestions:      Mapped[list["Suggestion"]]     = relationship(back_populates="document", cascade="all, delete-orphan")
    comments:         Mapped[list["Comment"]]        = relationship(back_populates="document", cascade="all, delete-orphan")
    edit_attributions:Mapped[list["EditAttribution"]]= relationship(back_populates="document", cascade="all, delete-orphan")
    notifications:    Mapped[list["Notification"]]   = relationship(back_populates="document", cascade="all, delete-orphan")
    versions:         Mapped[list["Version"]]        = relationship(back_populates="document", cascade="all, delete-orphan")
    approval_markers: Mapped[list["ApprovalMarker"]] = relationship(back_populates="document", cascade="all, delete-orphan")
    approval_step_events: Mapped[list["ApprovalStepEvent"]] = relationship(back_populates="document", cascade="all, delete-orphan")
    recommendations:  Mapped[list["Recommendation"]]= relationship(back_populates="document", cascade="all, delete-orphan")
    audit_logs:       Mapped[list["AuditLog"]]       = relationship(back_populates="document")
    stars:            Mapped[list["DocumentStar"]]   = relationship(back_populates="document", cascade="all, delete-orphan")
    # Additional folder placements (a doc can live in many folders — Admin page).
    # The canonical/primary location stays `folder_id`; these are extra pointers.
    folder_links:     Mapped[list["DocumentFolder"]] = relationship(back_populates="document", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_documents_folder", "folder_id"),
        Index("idx_documents_policy", "approval_policy_id"),
        Index("idx_documents_org",    "org_id"),
    )


class DocumentStar(Base):
    """
    PERSONAL bookmark — one row per (user, document) that the user has starred.
    Personal by design: one person starring a doc does NOT star it for everyone
    (the old global documents.starred column did, which was the wrong semantics).
    Starring needs only read access to the document, not edit rights.
    Composite PK (user_id, document_id) makes star/unstar idempotent.
    """
    __tablename__ = "document_stars"

    user_id:     Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True)
    org_id:      Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document: Mapped["Document"] = relationship(back_populates="stars")

    __table_args__ = (
        Index("idx_document_stars_user", "user_id"),
    )


class DocumentFolder(Base):
    """
    Many-to-many placement of a document into ADDITIONAL folders (beyond its
    canonical `documents.folder_id`). Lets the Admin file one document under
    several folders at once (the Folder(s) checkbox dropdown).

    Kept deliberately separate from `documents.folder_id` so nothing that reads
    the single primary location breaks — this table is purely additive. The
    effective set of a document's folders = {folder_id} ∪ these rows.
    Composite PK (document_id, folder_id) makes placement idempotent.
    """
    __tablename__ = "document_folders"

    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True)
    folder_id:   Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id", ondelete="CASCADE"), primary_key=True)
    org_id:      Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document: Mapped["Document"] = relationship(back_populates="folder_links")

    __table_args__ = (
        Index("idx_document_folders_folder", "folder_id"),
    )


class AiModel(Base):
    """
    Org-scoped catalog of AI models an admin may assign to users. This is the
    governed allow-list behind users.ai_model — a user stores a `model_key`
    that must resolve to an ENABLED row here.

    Rows are DERIVED from the Ask-AI router's config.yaml (see
    ai_model_service.seed_catalog), so `model_key` is the router's own
    'provider:model_key' identifier and every assignable model is by
    construction callable. config.yaml decides what exists; this table decides,
    per org, what is enabled and which model is the default. Vendor API keys are
    NOT stored here — they live only in backend/.env.

    `is_default` marks the org fallback used when a user's assigned model is
    unset, missing, or disabled, so AI never hard-fails on a stale value.
    UNIQUE (org_id, model_key) keeps the catalog free of duplicates.
    """
    __tablename__ = "ai_models"

    id:           Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:       Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    vendor:       Mapped[str]       = mapped_column(Text, nullable=False)   # groq / gemini / nvidia
    model_key:    Mapped[str]       = mapped_column(Text, nullable=False)   # e.g. groq:llama_70b
    display_name: Mapped[str]       = mapped_column(Text, nullable=False)
    enabled:      Mapped[bool]      = mapped_column(Boolean, nullable=False, server_default="true")
    is_default:   Mapped[bool]      = mapped_column(Boolean, nullable=False, server_default="false")
    created_at:   Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at:   Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        UniqueConstraint("org_id", "model_key", name="uq_ai_models_org_key"),
        Index("idx_ai_models_org", "org_id"),
    )


class AiUsageEvent(Base):
    """
    One row per AI model call, written by the Ask-AI endpoint (app/api/ai.py)
    once the vendor reports its real token counts. This is the metering behind
    the Admin "Model Usage" section (usage % by model, token totals per model,
    top documents by usage).

    Trust model: attribution is never taken from the client. org / user come from
    the caller's authenticated session and vendor / model from the backend's own
    resolution of users.ai_model, so a client cannot bill usage to someone else.
    document_id is the one client-supplied field and is validated against the
    caller's org before use. `request_id` is generated per call and unique, so a
    retry can never double-count.

    (The legacy /api/internal/ai/usage ingest — used when an external ai-gateway
    made the vendor call — still writes this table under a service JWT + grant.)

    Tokens-only for now; per-token pricing (and a derived cost column) is a
    deliberate later addition — no schema churn needed to add it.
    """
    __tablename__ = "ai_usage_events"

    id:            Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:        Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), nullable=False)
    # SET NULL on delete so usage history survives document/user removal (the
    # aggregations bucket orphaned rows under "unknown").
    document_id:   Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL"))
    user_id:       Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    vendor:        Mapped[str]              = mapped_column(Text, nullable=False)
    model_key:     Mapped[str]              = mapped_column(Text, nullable=False)
    input_tokens:  Mapped[int]              = mapped_column(Integer, nullable=False, server_default="0")
    output_tokens: Mapped[int]              = mapped_column(Integer, nullable=False, server_default="0")
    total_tokens:  Mapped[int]              = mapped_column(Integer, nullable=False, server_default="0")
    request_id:    Mapped[str]              = mapped_column(Text, nullable=False)
    created_at:    Mapped[datetime]         = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("request_id", name="uq_ai_usage_request"),
        Index("idx_ai_usage_org", "org_id"),
        Index("idx_ai_usage_document", "document_id"),
        Index("idx_ai_usage_model", "org_id", "model_key"),
        Index("idx_ai_usage_created", "created_at"),
    )


# =============================================================================
# GROUP C — Collaboration & review
# =============================================================================

class Suggestion(Base):
    """
    Each pending tracked change (insert / delete / replace / format).
    author_id = NULL means AI-authored.
    anchor is a Yjs relative position (JSONB).
    """
    __tablename__ = "suggestions"

    id:          Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:      Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), nullable=False)
    document_id: Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    author_id:   Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    origin:      Mapped[str]             = mapped_column(Text, nullable=False)   # human / ai
    type:        Mapped[str]             = mapped_column(Text, nullable=False)   # insert / delete / replace / format
    anchor:      Mapped[dict]            = mapped_column(JSONB, nullable=False)
    status:      Mapped[str]             = mapped_column(Text, nullable=False, server_default="pending")
    reason:      Mapped[Optional[str]]   = mapped_column(Text)
    resolved_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    resolved_at: Mapped[Optional[datetime]]  = mapped_column(DateTime(timezone=True))
    created_at:  Mapped[datetime]        = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document: Mapped["Document"]      = relationship(back_populates="suggestions")
    author:   Mapped[Optional["User"]]= relationship(back_populates="suggestions_authored", foreign_keys=[author_id])
    resolver: Mapped[Optional["User"]]= relationship(back_populates="suggestions_resolved", foreign_keys=[resolved_by])
    comments: Mapped[list["Comment"]] = relationship(back_populates="suggestion")

    __table_args__ = (
        Index("idx_suggestions_document", "document_id"),
    )


class Comment(Base):
    """
    Threaded discussion. parent_comment_id = NULL means top of thread.
    suggestion_id = NULL means doc-level comment (not linked to a suggestion).
    anchor = NULL means the comment is on the whole document.
    """
    __tablename__ = "comments"

    id:                Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:            Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), nullable=False)
    document_id:       Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    suggestion_id:     Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("suggestions.id"))
    anchor:            Mapped[Optional[dict]]   = mapped_column(JSONB)
    author_id:         Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    body:              Mapped[str]              = mapped_column(Text, nullable=False)
    is_resolved:       Mapped[bool]             = mapped_column(Boolean, nullable=False, server_default="false")
    parent_comment_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("comments.id"))
    created_at:        Mapped[datetime]         = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document:   Mapped["Document"]           = relationship(back_populates="comments")
    suggestion: Mapped[Optional["Suggestion"]] = relationship(back_populates="comments")
    author:     Mapped["User"]               = relationship(back_populates="comments")
    # Self-referencing: thread replies
    parent:  Mapped[Optional["Comment"]]  = relationship("Comment", back_populates="replies", remote_side="Comment.id")
    replies: Mapped[list["Comment"]]      = relationship("Comment", back_populates="parent")

    __table_args__ = (
        Index("idx_comments_document", "document_id"),
        Index("idx_comments_parent",   "parent_comment_id"),
    )


class EditAttribution(Base):
    """
    Per-region event history — who typed/deleted what and where.
    append-only: never updated, never deleted.
    """
    __tablename__ = "edit_attributions"

    id:          Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:      Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    author_id:   Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    type:        Mapped[str]       = mapped_column(Text, nullable=False)   # insert / delete
    anchor:      Mapped[dict]      = mapped_column(JSONB, nullable=False)
    note:        Mapped[Optional[str]] = mapped_column(Text)
    created_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document: Mapped["Document"] = relationship(back_populates="edit_attributions")
    author:   Mapped["User"]     = relationship(back_populates="edit_attributions")

    __table_args__ = (
        Index("idx_edit_attr_document", "document_id"),
    )


class Notification(Base):
    """
    Approval events delivered to users.
    delivered is a placeholder (unused in v1).
    """
    __tablename__ = "notifications"

    id:          Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:      Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    user_id:     Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    type:        Mapped[str]       = mapped_column(Text, nullable=False)
    payload:     Mapped[dict]      = mapped_column(JSONB, nullable=False)
    delivered:   Mapped[bool]      = mapped_column(Boolean, nullable=False, server_default="false")
    created_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    read_at:     Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    user:     Mapped["User"]     = relationship(back_populates="notifications")
    document: Mapped["Document"] = relationship(back_populates="notifications")

    __table_args__ = (
        Index("idx_notifications_user", "user_id"),
    )


# =============================================================================
# GROUP D — Versioning & approval governance
# =============================================================================

class Version(Base):
    """
    Named/approved versions. s3_key points to the materialized Slate blob.
    yjs_state_vector is the Yjs state at the time of snapshot.
    kind: "submission" (warm, in review) or "approved" (cold, final).
    """
    __tablename__ = "versions"

    id:               Mapped[uuid.UUID]      = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:           Mapped[uuid.UUID]      = mapped_column(UUID(as_uuid=True), nullable=False)
    document_id:      Mapped[uuid.UUID]      = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    version_no:       Mapped[int]            = mapped_column(Integer, nullable=False)
    kind:             Mapped[str]            = mapped_column(Text, nullable=False)   # submission / approved / rejected
    s3_key:           Mapped[str]            = mapped_column(Text, nullable=False)
    # Snapshot of the document's approval policy AT SUBMIT TIME. The approval
    # chain is resolved against THIS, not documents.approval_policy_id, so that
    # editing/detaching the policy mid-review cannot corrupt an in-flight
    # submission. NULL = the submission uses the single owner gate.
    approval_policy_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("approval_policies.id"))
    yjs_state_vector: Mapped[Optional[bytes]]= mapped_column(BYTEA)
    # Frozen Plate/Slate document value at snapshot time (JSONB). Powers the
    # version diff + restore UI. NULL on legacy rows created before 0006.
    content:          Mapped[Optional[list]] = mapped_column(JSONB)
    created_by:       Mapped[uuid.UUID]      = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at:       Mapped[datetime]       = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document:         Mapped["Document"]     = relationship(back_populates="versions")
    created_by_user:  Mapped["User"]         = relationship(back_populates="versions_created")
    approval_markers: Mapped[list["ApprovalMarker"]]   = relationship(back_populates="approved_version")
    approval_step_events: Mapped[list["ApprovalStepEvent"]] = relationship(back_populates="version")
    recommendations:  Mapped[list["Recommendation"]]   = relationship(back_populates="version")

    __table_args__ = (
        Index("idx_versions_document", "document_id"),
    )


class ApprovalPolicy(Base):
    """
    Names a multi-step approval chain.
    documents.approval_policy_id = NULL means the simple single-owner gate.
    """
    __tablename__ = "approval_policies"

    id:         Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:     Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    name:       Mapped[str]       = mapped_column(Text, nullable=False)
    is_active:  Mapped[bool]      = mapped_column(Boolean, nullable=False, server_default="true")
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    created_by_user: Mapped["User"]                   = relationship(back_populates="approval_policies")
    steps:           Mapped[list["ApprovalPolicyStep"]]= relationship(back_populates="policy", cascade="all, delete-orphan")
    documents:       Mapped[list["Document"]]          = relationship(back_populates="approval_policy")
    step_events:     Mapped[list["ApprovalStepEvent"]] = relationship(back_populates="policy")


class ApprovalMarker(Base):
    """
    The baseline pointer — latest row = current approved baseline.
    append-only: a new row is inserted on each approval.
    """
    __tablename__ = "approval_markers"

    id:                  Mapped[uuid.UUID]       = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:              Mapped[uuid.UUID]       = mapped_column(UUID(as_uuid=True), nullable=False)
    document_id:         Mapped[uuid.UUID]       = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    approved_version_id: Mapped[uuid.UUID]       = mapped_column(UUID(as_uuid=True), ForeignKey("versions.id"), nullable=False)
    yjs_state_vector:    Mapped[Optional[bytes]] = mapped_column(BYTEA)
    approved_by:         Mapped[uuid.UUID]       = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    approved_at:         Mapped[datetime]        = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document:         Mapped["Document"] = relationship(back_populates="approval_markers")
    approved_version: Mapped["Version"]  = relationship(back_populates="approval_markers")
    approver:         Mapped["User"]     = relationship(back_populates="approval_markers_by", foreign_keys=[approved_by])

    __table_args__ = (
        Index("idx_markers_document", "document_id"),
    )


class ApprovalPolicyStep(Base):
    """
    The ordered rungs of an approval chain.
    UNIQUE (policy_id, step_no) enforces ordering integrity.
    """
    __tablename__ = "approval_policy_steps"

    id:               Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:           Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    policy_id:        Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("approval_policies.id", ondelete="CASCADE"), nullable=False)
    step_no:          Mapped[int]       = mapped_column(Integer, nullable=False)
    required_role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roles.id"), nullable=False)
    min_approvals:    Mapped[int]       = mapped_column(Integer, nullable=False, server_default="1")
    created_at:       Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    policy:        Mapped["ApprovalPolicy"] = relationship(back_populates="steps")
    required_role: Mapped["Role"]           = relationship(back_populates="policy_steps")

    __table_args__ = (
        UniqueConstraint("policy_id", "step_no", name="uq_policy_step_no"),
        Index("idx_policy_steps_policy", "policy_id"),
    )


class ApprovalStepEvent(Base):
    """
    Per-submission runtime ledger — append-only record of each step decision.
    decision: "approved" or "rejected".
    """
    __tablename__ = "approval_step_events"

    id:          Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:      Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    version_id:  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("versions.id"), nullable=False)
    policy_id:   Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("approval_policies.id"), nullable=False)
    step_no:     Mapped[int]       = mapped_column(Integer, nullable=False)
    decision:    Mapped[str]       = mapped_column(Text, nullable=False)   # approved / rejected
    actor_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    note:        Mapped[Optional[str]] = mapped_column(Text)
    created_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document: Mapped["Document"]       = relationship(back_populates="approval_step_events")
    version:  Mapped["Version"]        = relationship(back_populates="approval_step_events")
    policy:   Mapped["ApprovalPolicy"] = relationship(back_populates="step_events")
    actor:    Mapped["User"]           = relationship(back_populates="approval_step_events")

    __table_args__ = (
        Index("idx_step_events_document", "document_id"),
        Index("idx_step_events_version",  "version_id"),
    )


class Recommendation(Base):
    """
    Owner notes attached to a version — on approve AND reject.
    status: open / addressed / orphaned.
    """
    __tablename__ = "recommendations"

    id:          Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:      Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    document_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    version_id:  Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("versions.id"), nullable=False)
    author_id:   Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    anchor:      Mapped[dict]      = mapped_column(JSONB, nullable=False)
    body:        Mapped[str]       = mapped_column(Text, nullable=False)
    status:      Mapped[str]       = mapped_column(Text, nullable=False, server_default="open")
    created_at:  Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    document:  Mapped["Document"] = relationship(back_populates="recommendations")
    version:   Mapped["Version"]  = relationship(back_populates="recommendations")
    author:    Mapped["User"]     = relationship(back_populates="recommendations", foreign_keys=[author_id])
    responses: Mapped[list["RecommendationResponse"]] = relationship(back_populates="recommendation", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_recommendations_document", "document_id"),
    )


class RecommendationResponse(Base):
    """
    The team's reply thread on a recommendation. append-only.
    """
    __tablename__ = "recommendation_responses"

    id:                Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    recommendation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False)
    author_id:         Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    body:              Mapped[str]       = mapped_column(Text, nullable=False)
    created_at:        Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    recommendation: Mapped["Recommendation"] = relationship(back_populates="responses")
    author:         Mapped["User"]           = relationship(back_populates="recommendation_responses")

    __table_args__ = (
        Index("idx_rec_responses_rec", "recommendation_id"),
    )


# =============================================================================
# GROUP E — Audit
# =============================================================================

class AuditLog(Base):
    """
    Append-only record of every governance action.
    document_id = NULL for actions not scoped to a document.
    """
    __tablename__ = "audit_log"

    id:          Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:      Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), nullable=False)
    actor_id:    Mapped[uuid.UUID]        = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    document_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("documents.id"))
    action:      Mapped[str]              = mapped_column(Text, nullable=False)
    target_type: Mapped[str]              = mapped_column(Text, nullable=False)
    target_id:   Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True))
    # "metadata" is reserved by SQLAlchemy; the DB column is still named "metadata"
    meta:        Mapped[Optional[dict]]   = mapped_column("metadata", JSONB)
    created_at:  Mapped[datetime]         = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    actor:    Mapped["User"]             = relationship(back_populates="audit_logs")
    document: Mapped[Optional["Document"]] = relationship(back_populates="audit_logs")

    __table_args__ = (
        Index("idx_audit_document", "document_id"),
    )


# =============================================================================
# GROUP F — Sessions (auth)
# =============================================================================

class RefreshToken(Base):
    """
    Server-side refresh-token store: turns logout/refresh from JWT-only stubs
    into real, revocable sessions.

    Security model:
      - The raw token is an opaque random string handed to the client; we store
        only its SHA-256 hash (token_hash), so a DB leak can't be replayed.
      - Rotation: each /auth/refresh revokes the presented token and issues a
        fresh one. Re-presenting an already-revoked token (reuse) signals theft
        and triggers revocation of the whole user's token family.
      - /auth/logout revokes the presented token.
    """
    __tablename__ = "refresh_tokens"

    id:         Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    org_id:     Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    user_id:    Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str]       = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False)
    revoked:    Mapped[bool]      = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime]  = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_refresh_tokens_hash"),
        Index("idx_refresh_tokens_user", "user_id"),
    )
