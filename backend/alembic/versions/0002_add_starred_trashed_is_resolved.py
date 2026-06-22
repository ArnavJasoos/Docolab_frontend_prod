"""add starred, trashed to documents; is_resolved to comments

Revision ID: 0002_add_starred_trashed_is_resolved
Revises: 0001_initial
Create Date: 2026-06-18

Three additive columns that support frontend UI features present in the mock
layer but absent from the original schema:

  documents.starred     — user bookmarks (personal, does not affect governance)
  documents.trashed     — recycle-bin soft-move (separate from status/delete)
  comments.is_resolved  — thread resolution state (Plate discussion plugin)

All three are non-nullable with a safe DEFAULT so the migration is zero-downtime:
existing rows get false automatically; no data backfill required.

NOTE on the revision id: Alembic's `alembic_version.version_num` column is
VARCHAR(32). The original id ("0002_add_starred_trashed_is_resolved", 36 chars)
overflowed it, so `alembic upgrade head` applied the DDL then failed writing the
version row and rolled the whole transaction back — the DB looked untouched and
stuck at 0001. The id is shortened to <=32 chars to fix this; the chain is
otherwise unchanged.
"""
from alembic import op
import sqlalchemy as sa

revision: str = "0002_doc_flags"
down_revision: str = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column("starred", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "documents",
        sa.Column("trashed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column(
        "comments",
        sa.Column("is_resolved", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("comments", "is_resolved")
    op.drop_column("documents", "trashed")
    op.drop_column("documents", "starred")
