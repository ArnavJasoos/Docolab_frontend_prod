"""v2 features: refresh-token store, personal stars, trash timestamp, approval snapshot

Revision ID: 0004_auth_stars_trash
Revises: 0003_yjs_state
Create Date: 2026-06-19

Schema delta for the v2 governance/auth round:

  + refresh_tokens          real, revocable sessions (rotation + reuse-detection)
  + document_stars          PERSONAL bookmarks (per-user), replaces the global flag
  - documents.starred       dropped — bookmarks are personal now (document_stars)
  + documents.trashed_at    when a doc entered the recycle bin (reversible)
  + versions.approval_policy_id   policy snapshot taken at submit (deterministic
                                  in-flight approval, independent of later edits)

Revision ids are kept <=32 chars on purpose: Alembic's alembic_version.version_num
is VARCHAR(32); a longer id breaks `alembic upgrade head` (see migration 0002).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0004_auth_stars_trash"
down_revision: str = "0003_yjs_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- refresh-token store -------------------------------------------------
    op.create_table(
        "refresh_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash", name="uq_refresh_tokens_hash"),
    )
    op.create_index("idx_refresh_tokens_user", "refresh_tokens", ["user_id"], unique=False)

    # --- personal bookmarks --------------------------------------------------
    op.create_table(
        "document_stars",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("document_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["document_id"], ["documents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "document_id"),
    )
    op.create_index("idx_document_stars_user", "document_stars", ["user_id"], unique=False)

    # --- drop the old global star flag (now personal via document_stars) -----
    op.drop_column("documents", "starred")

    # --- reversible recycle-bin timestamp ------------------------------------
    op.add_column("documents", sa.Column("trashed_at", sa.DateTime(timezone=True), nullable=True))

    # --- approval policy snapshot on the submission --------------------------
    op.add_column(
        "versions",
        sa.Column("approval_policy_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_versions_approval_policy", "versions", "approval_policies",
        ["approval_policy_id"], ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_versions_approval_policy", "versions", type_="foreignkey")
    op.drop_column("versions", "approval_policy_id")
    op.drop_column("documents", "trashed_at")
    # restore the old global star flag
    op.add_column(
        "documents",
        sa.Column("starred", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.drop_index("idx_document_stars_user", table_name="document_stars")
    op.drop_table("document_stars")
    op.drop_index("idx_refresh_tokens_user", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
