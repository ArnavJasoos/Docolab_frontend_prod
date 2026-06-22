"""role permission updates: approver+can_edit_direct, editor+can_submit_for_approval, drop suggester

Revision ID: 0005_role_perms
Revises: 0004_auth_stars_trash
Create Date: 2026-06-19

Reconciles ALREADY-SEEDED orgs with the new role model (the startup seed only
runs on a fresh DB, so existing orgs need this):

  + approver gains can_edit_direct        (reviewers can also edit directly)
  + editor   gains can_submit_for_approval (editors can submit their own work)
  - the 'suggester' role is removed entirely (redundant). Any assignment using it
    is dropped first to satisfy the assignments.role_id FK; the role's
    role_permissions rows cascade away when the role row is deleted.

Operates by role NAME across all orgs, and is idempotent (re-runnable).
Revision id kept <=32 chars (alembic_version is VARCHAR(32); see migration 0002).
"""
from alembic import op
import sqlalchemy as sa

revision: str = "0005_role_perms"
down_revision: str = "0004_auth_stars_trash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # approver can now edit content directly
    conn.execute(sa.text(
        "INSERT INTO role_permissions (role_id, permission) "
        "SELECT id, 'can_edit_direct' FROM roles WHERE name = 'approver' "
        "ON CONFLICT (role_id, permission) DO NOTHING"
    ))
    # editors can now submit their own work for approval
    conn.execute(sa.text(
        "INSERT INTO role_permissions (role_id, permission) "
        "SELECT id, 'can_submit_for_approval' FROM roles WHERE name = 'editor' "
        "ON CONFLICT (role_id, permission) DO NOTHING"
    ))
    # remove the redundant 'suggester' role (drop its assignments first)
    conn.execute(sa.text(
        "DELETE FROM assignments WHERE role_id IN (SELECT id FROM roles WHERE name = 'suggester')"
    ))
    conn.execute(sa.text("DELETE FROM roles WHERE name = 'suggester'"))


def downgrade() -> None:
    conn = op.get_bind()
    # undo the added permissions
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE permission = 'can_edit_direct' "
        "AND role_id IN (SELECT id FROM roles WHERE name = 'approver')"
    ))
    conn.execute(sa.text(
        "DELETE FROM role_permissions WHERE permission = 'can_submit_for_approval' "
        "AND role_id IN (SELECT id FROM roles WHERE name = 'editor')"
    ))
    # recreate the suggester role per org (best-effort; old assignments are NOT restored)
    conn.execute(sa.text(
        "INSERT INTO roles (id, org_id, name) "
        "SELECT gen_random_uuid(), org_id, 'suggester' FROM (SELECT DISTINCT org_id FROM roles) o "
        "ON CONFLICT (org_id, name) DO NOTHING"
    ))
    conn.execute(sa.text(
        "INSERT INTO role_permissions (role_id, permission) "
        "SELECT r.id, p.permission FROM roles r "
        "CROSS JOIN (VALUES ('can_suggest'), ('can_view_history')) AS p(permission) "
        "WHERE r.name = 'suggester' "
        "ON CONFLICT (role_id, permission) DO NOTHING"
    ))
