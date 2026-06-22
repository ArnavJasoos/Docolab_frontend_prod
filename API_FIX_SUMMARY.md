# API Fix Summary

**Branch:** `fix/api-missing-routes`  
**Date:** 2026-06-22  
**All tests:** 44 / 44 passed

---

## Overview

10 API endpoints were broken. They fell into two categories:

| Category | Count | Cause |
|----------|-------|-------|
| Routes returning 404 (not found) | 8 | Stale server process — endpoints existed in code but the server had never reloaded after the v2 commit |
| Routes returning 403 (forbidden) | 2 | Code bugs: missing DB row + broken RBAC scope walk |

---

## Root Cause 1 — Stale Server Process (Fixes 1–6, 8, 10 partial)

**Affected endpoints:**

| # | Method | Endpoint | Error Before | After Fix |
|---|--------|----------|--------------|-----------|
| 1 | POST | `/api/auth/refresh` | 404 Not Found | ✅ 200 — returns new access + refresh token |
| 2 | POST | `/api/auth/logout` | 404 Not Found | ✅ 200 — revokes refresh token |
| 3 | GET | `/api/documents` (no `folder_id`) | 422 Validation Error | ✅ 200 — `folder_id` is optional |
| 4 | GET | `/api/audit` | 404 Not Found | ✅ 200 — org-wide audit log for admins |
| 5 | PUT | `/api/documents/{id}/star` | 404 Not Found | ✅ 200 — personal bookmark added |
| 6 | DELETE | `/api/documents/{id}/star` | 404 Not Found | ✅ 200 — personal bookmark removed |
| 8 | PATCH | `/api/approval-policies/{id}` | 404 Not Found | ✅ 200 — policy updated |
| 10 | GET | `/api/versions/{id}/approval-status` | 404 Not Found | ✅ 200 — chain progress returned |

**What happened:**  
The v2 feature commit (`15249a6`) added all these routes, but the running server was started before that commit and never reloaded. The `reload=True` flag in `uvicorn.run()` only watches for file changes in the process that started it — a process started earlier won't pick up new code.

**Fix:**  
Kill the stale Python process and restart with:
```bash
cd Docolab/backend
python run.py
```
On startup, Alembic runs `upgrade head`, which applied migration `0004_auth_stars_trash` — creating the `refresh_tokens` and `document_stars` tables needed by fixes 1, 2, 5, and 6.

> **Note on migration:** The database was missing the `alembic_version` tracking table, so Alembic attempted to re-run all migrations from scratch and hung. Fixed by manually inserting the correct version stamp (`0003_yjs_state`) before restarting.

---

## Root Cause 2 — Missing Org-Scoped DB Row (Fix 7, 9)

**Affected endpoints:**

| # | Method | Endpoint | Error Before | After Fix |
|---|--------|----------|--------------|-----------|
| 7 | POST | `/api/approval-policies` | 403 Forbidden | ✅ 201 — policy created |
| 9 | PATCH | `/api/documents/{id}/approval-policy` | 403 Forbidden | ✅ 200 — policy attached/detached |

**What happened:**  
Both endpoints require the `can_manage_approval_policy` permission. The v2 startup seed was supposed to create an org-scoped `owner` assignment for the admin user. However, the seed block was guarded by:

```python
if admin is None:   # only runs on FIRST startup (when admin doesn't exist yet)
    ...
    db.add(Assignment(..., scope_type="org", ...))
```

Because the admin was created by an *earlier* version of the seed (before v2 added the org-scoped assignment), this `if` branch was skipped on every subsequent restart. The org assignment was never inserted into the database.

**Fix — `backend/app/main.py`** (commit `cc30af1`):

Added an `else` branch that checks for the org assignment on *existing* admins and backfills it if missing:

```python
# Before (v2 startup code — only ran for brand-new admins):
if admin is None:
    ...
    db.add(Assignment(..., scope_type="org", scope_id=org_id))
    await db.commit()

# After — also handles pre-existing admins:
if admin is None:
    ...
    db.add(Assignment(..., scope_type="org", scope_id=org_id))
    await db.commit()
else:
    # Backfill org-scoped assignment if it was never created (pre-v2 admin)
    owner_role = await db.execute(select(Role).where(...name == "owner"))...
    if owner_role:
        existing = await db.execute(select(Assignment).where(
            Assignment.user_id == admin.id,
            Assignment.scope_type == "org",
            Assignment.scope_id == org_id,
        ))...
        if existing is None:
            db.add(Assignment(
                org_id=org_id,
                user_id=admin.id,
                role_id=owner_role.id,
                scope_type="org",
                scope_id=org_id,
            ))
            await db.commit()
```

**File changed:** `backend/app/main.py` — lines 167–194

---

## Root Cause 3 — Broken RBAC Scope Walk (Fix 9 partial)

**Affected endpoint:**

| # | Method | Endpoint | Error Before | After Fix |
|---|--------|----------|--------------|-----------|
| 9 | PATCH | `/api/documents/{id}/approval-policy` | 403 Forbidden | ✅ 200 — org-owner can attach policy to any doc |

**What happened:**  
The RBAC permission check for this endpoint calls `require_permission(..., "document", doc.id)`. The `resolve_role` function walks the scope hierarchy to find the user's role:

```
document → folder → parent folders → ???
```

When it reached the root folder (no parent), it stopped the walk and returned "no role found" — even though the user held an org-scoped owner assignment. Org scope was never checked as a fallback when the folder walk ran out.

**Fix — `backend/app/services/auth_service.py`** (commit `cc30af1`):

Extended the folder walk to fall through to org scope when the root folder is reached:

```python
# Before — stopped at root folder:
elif current_scope_type == "folder":
    folder = await db.execute(select(Folder)...)...
    if folder and folder.parent_folder_id:
        current_scope_id = folder.parent_folder_id
    else:
        break   # ← stopped here, never checked org scope

# After — falls through to org scope:
elif current_scope_type == "folder":
    folder = await db.execute(select(Folder)...)...
    if folder and folder.parent_folder_id:
        current_scope_id = folder.parent_folder_id
    else:
        # Root folder reached — check org scope as final authority
        org_id = folder.org_id if folder else None
        if org_id is not None:
            current_scope_type = "org"
            current_scope_id = org_id
        else:
            break
```

**File changed:** `backend/app/services/auth_service.py` — lines 53–61

This means the full scope resolution order is now:
```
document → folder → parent folders → root folder → org
```
An org-scoped owner can act on any document or folder in the org without needing a direct per-resource assignment.

---

## Files Changed

| File | Change |
|------|--------|
| `backend/app/main.py` | Added `else` block in startup seed to backfill org-scoped assignment for pre-existing admins |
| `backend/app/services/auth_service.py` | Extended `resolve_role` scope walk to fall through to org scope after exhausting folder hierarchy |
| `backend/integration_test.py` | Added (was untracked) — integration test script covering all API endpoints |

---

## Test Results (44 / 44)

| Fix | Endpoint | Scenarios Tested | Result |
|-----|----------|-----------------|--------|
| 1 | `POST /api/auth/refresh` | New tokens returned; old token revoked after rotation; revoked token cannot re-refresh | ✅ 4/4 |
| 2 | `POST /api/auth/logout` | Returns `success:true`; revoked token cannot be used to refresh | ✅ 2/2 |
| 3 | `GET /api/documents` | Works without `folder_id`; also works with `?folder_id=`; no 422 error | ✅ 3/3 |
| 4 | `GET /api/audit` | Admin receives entries; non-admin receives 403 | ✅ 4/4 |
| 5 | `PUT /api/documents/{id}/star` | Returns `starred:true`; doc appears in `?starred=true` filter; idempotent | ✅ 4/4 |
| 6 | `DELETE /api/documents/{id}/star` | Returns `starred:false`; doc removed from `?starred=true` filter; idempotent | ✅ 3/3 |
| 7 | `POST /api/approval-policies` | Single-step and two-step policies created; no 403 for org admin | ✅ 5/5 |
| 8 | `PATCH /api/approval-policies/{id}` | Rename works; `min_approvals` updates; `is_active` toggles | ✅ 4/4 |
| 9 | `PATCH /api/documents/{id}/approval-policy` | Attach policy; detach (null); no 403 for org-owner | ✅ 5/5 |
| 10 | `GET /api/versions/{id}/approval-status` | Returns `policy_id`, `steps`, `next_step`, `complete`; not 404 | ✅ 7/7 |
| — | `GET /api/approval-policies` | Lists all policies including newly created ones | ✅ 3/3 |

---

## How to Reproduce the Fix

```bash
# 1. Switch to the fix branch
cd Docolab
git checkout fix/api-missing-routes

# 2. Start the backend (auto-migrates on startup)
cd backend
python run.py

# 3. Verify all APIs
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@acme.com","password":"adminsecret"}'
```
