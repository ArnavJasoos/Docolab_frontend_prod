"""Reset the AI catalog so it re-derives from the trimmed config.yaml.

config.yaml was trimmed to five models and its default_model moved to
'gemini:gemini_2_5_flash'. Two things in the database would otherwise survive
that change and contradict it:
  - rows for models no longer in config.yaml (they would still be assignable,
    and would fail at call time — the exact bug 0012 removed);
  - the previous default flag, which seed_org_catalog will not override (it
    only claims is_default on a FRESH catalog, so an admin's later choice is
    never silently overwritten).

So clear the catalog and let startup seeding (main.py ->
ai_model_service.seed_org_catalog) rebuild it from config.yaml with the correct
default. Clearing users.ai_model alongside keeps assignments from pointing at
rows that are about to disappear; an empty value resolves to the org default,
so every user lands on Gemini 2.5 Flash until an admin assigns otherwise.

This DOES discard per-org enable/disable and default choices. That is intended
here — the catalog is being redefined — and on a catalog whose rows were all
seeded it is a no-op in practice. It stays independent of config.yaml's
contents, so it cannot drift from whatever the router actually has.

Revision ID: 0013_trim_ai_catalog
Revises: 0012_ask_ai_catalog
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0013_trim_ai_catalog"
down_revision: str = "0012_ask_ai_catalog"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DELETE FROM ai_models")
    op.execute("UPDATE users SET ai_model = ''")
    op.execute("UPDATE documents SET ai_model = ''")


def downgrade() -> None:
    # Nothing to restore: the catalog is derived state, rebuilt from config.yaml
    # on the next startup. Downgrading only leaves it to be reseeded again.
    pass
