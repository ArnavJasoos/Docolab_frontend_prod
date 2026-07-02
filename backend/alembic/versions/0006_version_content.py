"""add content (Slate JSON) to versions

Revision ID: 0006_version_content
Revises: 0005_role_perms
Create Date: 2026-07-02

Stores the frozen Plate/Slate document value on each version row so version
history can actually diff/restore content. Before this, versions carried only
metadata (a placeholder s3_key) and the frontend kept snapshot bodies in
localStorage — invisible to other users and lost per-browser.

NULL = legacy version created before this column existed (no content captured).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0006_version_content"
down_revision: str = "0005_role_perms"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "versions",
        sa.Column("content", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("versions", "content")
