"""add yjs_state column to documents

Revision ID: 0003_add_yjs_state_to_documents
Revises: 0002_add_starred_trashed_is_resolved
Create Date: 2026-06-18

Stores the serialised Yjs Y.Doc state vector as BYTEA on the documents table.
The Hocuspocus server reads this on first client connect (onLoadDocument) and
writes it back after each edit burst (onStoreDocument, debounced 2s).

NULL = new document with no content yet (Hocuspocus starts a fresh Y.Doc).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import BYTEA

revision: str = "0003_yjs_state"
down_revision: str = "0002_doc_flags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column("yjs_state", BYTEA(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("documents", "yjs_state")
