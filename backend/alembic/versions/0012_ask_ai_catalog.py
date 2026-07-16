"""Repoint the AI catalog at the Ask-AI router's own model namespace.

The catalog was seeded with vendor/model_keys ('google:gemini-2.5-flash',
'openai:gpt-4o', ...) that no configured router could actually call — a
namespace that never overlapped the Ask-AI router's config.yaml. Now that the
router lives in the backend, a model_key IS the router's identifier
('provider:model_key', e.g. 'groq:llama_70b').

This migration drops the old, uncallable rows and clears any users.ai_model
still pointing at one. It deliberately does NOT insert the new rows: startup
seeding (main.py -> ai_model_service.seed_org_catalog) reconciles every org's
catalog against config.yaml, so the catalog can never drift from the models the
router actually has, and this migration stays independent of config.yaml's
contents at the time it runs.

An empty users.ai_model resolves to the org default (ai_model_service.resolve),
so users keep working AI while an admin picks their model.

Revision ID: 0012_ask_ai_catalog
Revises: 0011_user_ai_model
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_ask_ai_catalog"
down_revision: str = "0011_user_ai_model"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Router identifiers always contain ':' — anything without one is a row from
    # the old, uncallable namespace.
    op.execute("DELETE FROM ai_models WHERE model_key NOT LIKE '%:%'")
    op.execute("UPDATE users SET ai_model = '' WHERE ai_model NOT LIKE '%:%'")
    op.execute("UPDATE documents SET ai_model = '' WHERE ai_model NOT LIKE '%:%'")

    # The old per-vendor default is meaningless in the new namespace; let the
    # empty string mean "use the org default".
    op.alter_column("users", "ai_model", server_default="")
    op.alter_column("documents", "ai_model", server_default="")


def downgrade() -> None:
    # The old catalog rows are not restored: they named models nothing could
    # call, so recreating them would only reintroduce broken assignments. Only
    # the column defaults are reverted.
    op.alter_column("users", "ai_model", server_default="gemini-2.5-flash")
    op.alter_column("documents", "ai_model", server_default="gemini-2.5-flash")
