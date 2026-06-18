# Docolab — Changes From the Initial Design

**Baseline document:** `Collaborative_Documentation_Platform_PLATE_v2.md` (the "PLATE v2" architecture) and `API_WORK_DIVISION_UPDATED.md`.
**This document:** what changed in the actual backend implementation versus that baseline — what was added, how it works, what was removed, why, and what is still missing.

> **One-sentence summary:** The database design is **unchanged** (still 18 tables, no field added/removed/altered). What changed is the *implementation*: the backend is now fully **async**, the codebase finally **completes the "identity spine"** the design assumed (one shared org, seeded roles, an owner that actually exists), and two intentional features were added — **creator-owns-on-create** (the first role assignment) and **ownership transfer** (handover). Everything else is bug-fixes that make the documented behavior actually run.

---

## 0. Change summary

| # | Change | Type | Design impact |
|---|---|---|---|
| 1 | Sync → **async** SQLAlchemy across the whole backend | Code alignment | None (PLATE v2 already specifies an async stack) |
| 2 | **Single shared org** for v1 (signup joins one org, not a new one per user) | Behavior fix | Completes design §2 ("single org, hundreds of users") |
| 3 | **Role seeding** fixed (roles + permissions + a real owner + root folder) | Bug fix / completion | Completes design §13 step 1 |
| 4 | **Creator-owns-on-create** (creator becomes owner of new folder/document) | **New feature** | Additive; no schema change |
| 5 | **Ownership transfer** endpoint (handover) | **New feature** | Additive; no schema change |
| 6 | **14 collaboration endpoints** (suggestions, comments, recommendations, audit, auth refresh/logout) | New endpoints | Matches design §9 |
| 7 | Response schemas use native `UUID`/`datetime` types | Code fix | None (same JSON on the wire) |
| 8 | Bug fixes: `assignments` audit write; `versions` approval-step write | Bug fix | None |
| 9 | Added `pydantic-settings` dependency; added `DEFAULT_ORG_ID` config | Infra | None |

**No table or column was added, removed, or changed. The 18-table schema in `database_models.py` is identical to PLATE v2.**

---

## 1. Change 1 — Synchronous → Asynchronous data layer

**Before:** `app/core/database.py` defined an **async** engine/session (`create_async_engine`, `AsyncSession`), but every route file used **synchronous** SQLAlchemy (`db.query(...)`, plain `def`). An async session has no `.query()` method, so every protected endpoint would have failed at runtime. The two halves were incompatible.

**After:** the entire backend is async and consistent:
- `app/api/deps.py::get_current_user` and `app/services/auth_service.py::authorize` are now `async def` and use `await db.execute(select(...))`.
- Every route in `auth, users, roles, folders, documents, assignments, versions, notifications, ai, export` plus the new collaboration routers is `async def` with `await db.execute(...)`, `await db.commit()`, `await db.refresh()`, `await db.delete()`.
- The only sync handlers left are `auth/refresh` and `auth/logout` — they touch no database, so they stay plain functions.

**Why:** PLATE v2 (§3, §4) specifies an async stack, and `database.py` was already async. This brings the code in line with the documented design rather than changing it. JSON responses are unchanged.

---

## 2. Change 2 — Organization model (how orgs are assigned)

**What an org is:** an org = **a team / tenant** (a company or workspace), not a person. `org_id` is a column on every table and is the **isolation boundary** — users in org A never see org B's data. PLATE v2 §5 calls `org_id` "the single-tenant hook for a future multi-tenant migration." v1 is explicitly "single org, hundreds of users" (§2).

**Before (bug):** `signup` did `org_id = uuid.uuid4()` — it created a **brand-new org for every user**, isolating each person into a one-member tenant. Two users could never collaborate.

**After:** there is **one shared org** for v1.
- `app/core/config.py` defines `DEFAULT_ORG_ID` (a fixed UUID, env-overridable).
- `app/api/auth.py::signup` now sets `User(org_id=settings.DEFAULT_ORG_ID, ...)`. Every signup **joins the one org**.

**How an org is "assigned" to a user:** purely via the `users.org_id` column, set at signup. There is no separate org table or membership table — membership is implicit in `org_id`. This is exactly the PLATE v2 model; we just populate it correctly.

**Future multi-org:** because every table already carries `org_id`, supporting multiple orgs later means letting signup/admin choose an org id instead of always using `DEFAULT_ORG_ID` — **no schema change**.

---

## 3. Change 3 — Identity spine: role seeding (how roles are defined)

**Before (bug):** the startup seed created `Role(id="role-owner", ...)` — but (a) `"role-owner"` is **not a valid UUID** for the `UUID` primary-key column, and (b) it omitted the `NOT NULL` `org_id`. Either one crashes the seed, which crashes startup, which means the server never serves a single request.

**After:** `app/main.py::startup_event` seeds correctly and idempotently:
1. **Roles** (`roles` table) for `DEFAULT_ORG_ID` with real UUID ids: `owner, approver, editor, suggester, viewer`.
2. **Permissions** (`role_permissions` table) per role:

   | Role | Permissions |
   |---|---|
   | owner | `can_edit_direct, can_suggest, can_resolve_suggestion, can_submit_for_approval, can_give_final_approval, can_approve_level, can_manage_approval_policy, can_view_history, can_manage_members` |
   | approver | `can_suggest, can_resolve_suggestion, can_submit_for_approval, can_give_final_approval, can_approve_level, can_view_history` |
   | editor | `can_edit_direct, can_suggest, can_view_history` |
   | suggester | `can_suggest, can_view_history` |
   | viewer | `can_view_history` |

3. A **first owner**: the admin user (`admin@acme.com` / `adminsecret`) and a real **root folder** ("Workspace"), with an `assignments` row giving the admin the `owner` role on that folder.

Guarded by existence checks so it runs once. **Role ids are now UUIDs** — code must look them up via `GET /api/roles`, not hardcode strings like `"role-owner"`.

**How a role is checked (the RBAC "walk"):** `authorize(db, user_id, permission, scope_type, scope_id)` (in `app/services/auth_service.py`):
1. Look for an `assignments` row matching `(user_id, scope_type, scope_id)`.
2. If found → load its `role`, check `role_permissions` for `permission`, return `(has_permission, role_name, "scope:id")`.
3. If not found → **climb the hierarchy**: `document → its folder (documents.folder_id) → parent folders (folders.parent_folder_id)` and repeat, until an assignment is found or the hierarchy ends.

So a role granted on a *folder* is inherited by every document inside it, and a role granted directly on a *document* takes precedence (it's checked first).

---

## 4. Change 4 — Creator-owns-on-create (how the FIRST role is assigned)

**The problem it solves (the "bootstrap"):** roles only come from `assignments` rows, and the only endpoint that creates them (`POST /assignments`) itself requires `can_manage_members` — which a brand-new user doesn't have. So without this, a fresh user could never get any permission, and guarded actions always returned 403.

**The feature:** **whoever creates a folder or document is automatically granted the `owner` role on it**, in the same transaction.

**How it's implemented:**
- A helper `_grant_owner(db, user, scope_type, scope_id)` in both `app/api/folders.py` and `app/api/documents.py`:
  1. Looks up the org's owner role: `select(Role).where(Role.org_id == user.org_id, Role.name == "owner")`.
  2. Inserts `Assignment(org_id, user_id=user.id, role_id=owner.id, scope_type, scope_id)`.
- `create_folder` calls it with `scope_type="folder", scope_id=folder.id`.
- `create_document` calls it with `scope_type="document", scope_id=doc.id`.

**The API calls and DB fields that make it work:**
- API: `POST /api/folders`, `POST /api/documents` (creation now also writes the ownership row).
- DB: `assignments(org_id, user_id, role_id, scope_type, scope_id)` — the new row; `roles`/`role_permissions` — to resolve "owner"; `documents.folder_id` + `folders.parent_folder_id` — so the ownership inherits down the tree.

**Concrete scenario (manager/junior):** a junior is asked to create a document. They `POST /api/documents` → they get an `assignments` row making them `owner` of that document. They can now suggest, resolve, view history, and manage members on it — and later hand it to the manager.

---

## 5. Change 5 — Ownership transfer / handover (how a role is transferred)

**The problem it solves:** "ownership" is not a column — it's `assignments` rows. Transferring it with the base endpoints means `POST /assignments` + `DELETE /assignments/{id}` — two calls, not atomic, easy to get wrong (you can delete your own owner row and lock everyone out, or hit the `UNIQUE(user_id, scope_type, scope_id)` constraint). There is no `PATCH /assignments`.

**The feature:** a single atomic, audited endpoint.

- **API call:** `POST /api/documents/{id}/transfer-ownership`
- **Body:** `{ "to_user_id": "<uuid>", "demote_to": "editor" }` (`demote_to` ∈ `approver|editor|suggester|viewer`, default `editor`).
- **File:** `app/api/ownership.py`.

**How it works (one transaction, in the safe order):**
1. Load the document (`documents`), 404 if not in the caller's org.
2. `authorize(can_manage_members)` on the document → 403 if the caller isn't allowed (only `owner` holds this).
3. Reject transfer-to-self (400) and a target outside the org (400).
4. Resolve the org's `owner` role and the `demote_to` role by name (409/400 if missing).
5. **Grant the new owner first**: upsert a **document-scoped** `assignments` row for `to_user_id` with the `owner` role.
6. **Demote the caller**: upsert a **document-scoped** `assignments` row for the caller with the `demote_to` role. Because the authorize walk checks the **document scope before the folder**, this row *overrides* any ownership the caller inherited from a parent folder — **for this document only** (folder-level ownership is left untouched).
7. Write one `audit_log` row.
8. Commit.

**The API calls and DB fields that make it work:**
- DB writes: `assignments` (two upserted document-scoped rows), `audit_log` (`org_id, actor_id, document_id, action="ownership_transfer", target_type="document", target_id, meta={from_user, to_user, previous_owner_role, demoted_caller_to}`).
- Key field that enables clean override: `assignments.scope_type` + `scope_id` (document scope beats folder scope in `authorize`), and `UNIQUE(user_id, scope_type, scope_id)` (so we upsert rather than duplicate).

**Result:** after the call, the new owner can resolve suggestions/approve/manage members on that document; the previous owner is whatever `demote_to` says (e.g. an editor — can still suggest, but can no longer resolve). The new owner can transfer it back (they now hold `can_manage_members`).

---

## 6. Change 6 — New collaboration endpoints (14)

These are the Person A endpoints from `API_WORK_DIVISION_UPDATED.md` §3, all async, all guarded, mounted at the canonical paths (`prefix=/api`).

| Endpoint | File | Notes |
|---|---|---|
| `POST /api/auth/refresh` | `auth.py` | JWT-only stub (no refresh-token table in v1) |
| `POST /api/auth/logout` | `auth.py` | JWT-only stub |
| `GET /api/documents/{id}/suggestions` | `suggestions.py` | optional `?status=` filter |
| `POST /api/documents/{id}/suggestions` | `suggestions.py` | human or AI (`origin`); `can_suggest` |
| `POST /api/suggestions/{id}/accept` | `suggestions.py` | `can_resolve_suggestion`; writes an `edit_attributions` row |
| `POST /api/suggestions/{id}/reject` | `suggestions.py` | `can_resolve_suggestion` |
| `GET /api/documents/{id}/comments` | `comments.py` | optional `?since=` |
| `POST /api/documents/{id}/comments` | `comments.py` | threaded via `parent_comment_id`; `can_suggest` |
| `GET /api/versions/{id}/recommendations` | `recommendations.py` | |
| `POST /api/versions/{id}/recommendations` | `recommendations.py` | `can_give_final_approval` |
| `PATCH /api/recommendations/{id}` | `recommendations.py` | status `open/addressed/orphaned` |
| `GET /api/recommendations/{id}/responses` | `recommendations.py` | |
| `POST /api/recommendations/{id}/responses` | `recommendations.py` | **append-only** (no PATCH/DELETE by design) |
| `GET /api/documents/{id}/audit` | `audit.py` | `can_view_history`; read-only |

All write/read against existing tables (`suggestions, comments, recommendations, recommendation_responses, edit_attributions, audit_log`) with `org_id` isolation.

---

## 7. Change 7 — Response schema types

**Before:** Pydantic response schemas used `id: str` / `created_at: str`. Under Pydantic v2, a `str` field does **not** accept a `uuid.UUID` or `datetime` value (it raises), so any endpoint returning ORM objects would 500 on serialization.

**After:** response schemas use native `uuid.UUID` and `datetime` types (e.g. `schemas/auth.py`, `document.py`, `folder.py`, `role.py`, `assignment.py`, `version.py`, `notification.py`, and the new collaboration schemas). These accept ORM values **and** strings, and serialize to the **same JSON** (string UUIDs, ISO datetimes). No contract change.

---

## 8. Change 8 — Bug fixes that unblock the documented behavior

- **`assignments.py` audit write:** previously `AuditLog(metadata_json=json.dumps(...))` — a column that doesn't exist, and it omitted the required `org_id`. Now: `AuditLog(org_id=..., actor_id=..., target_type=..., target_id=..., meta={...})` (the `meta` attribute maps to the DB column `metadata`).
- **`versions.py` approval:** previously it read the `doc.approval_policy` relationship (a lazy load that fails under async) and wrote an `ApprovalStepEvent` with `policy_id=None` for single-gate docs (violates `NOT NULL`). Now it reads the `documents.approval_policy_id` FK column directly and writes an `ApprovalStepEvent` **only when a policy is attached** — which is exactly PLATE v2 §8.6 ("NULL policy → no `approval_step_events` rows").

---

## 9. Dependencies & config

- `requirements.txt`: added **`pydantic-settings`** (imported by `config.py` but previously missing — it would have crashed import).
- `config.py`: added **`DEFAULT_ORG_ID`** (the single v1 org).

---

## 10. What was REMOVED

- **Nothing from the design** — no table, column, endpoint, or documented behavior was removed.
- Internally: two temporary helper files (`deps_async.py`, `auth_service_async.py`) that briefly existed during the migration were **merged back** into `deps.py` / `auth_service.py` and deleted, so there's a single source of truth.
- The **broken behaviors** were replaced: new-org-per-signup, invalid string role ids, and the crashing seed are gone.

---

## 11. Why we chose these approaches

- **Async everywhere:** the design and `database.py` are async; making the routes async fixes a guaranteed runtime failure without inventing anything new.
- **Single shared org:** matches PLATE v2 §2 exactly; `org_id` stays the future multi-tenant hook, so multi-org later needs no schema change.
- **Creator-owns:** the cleanest solution to the bootstrap deadlock — it requires no new table, mirrors how most tools work ("you own what you make"), and makes a fresh user immediately productive.
- **Dedicated transfer endpoint** (vs. raw assignment calls): atomicity + safety (never ownerless) + a built-in audit trail, while still being "just `assignments` rows" under the hood.
- **Native UUID/datetime schemas:** correctness under Pydantic v2 with zero change to the JSON contract.
- **No schema change anywhere:** the 18-table design already supports RBAC, ownership, and audit; everything here is *completing* that design, not altering it.

---

## 12. What is still missing / future iterations

**Needed soon (small, well-scoped):**
- **CORS middleware** in `main.py` — required before any browser frontend can call the API.
- **`create_document` permission guard** — today any org member can create a document in any folder (then owns it via creator-owns). Add a `can_edit_direct`-on-folder check to close this.
- **Controlled onboarding** — joining the org is currently open self-signup. Add an owner-only "add member" endpoint (no schema change) or an invite-link flow (one new `invitations` table) when you want gated joining.
- **Real refresh-token store** — `auth/refresh` / `auth/logout` are JWT-only stubs; a real implementation needs a refresh-token table or store (persist / rotate / revoke).

**Deferred per the design (still placeholders):**
- **Live collaborative editing** (Yjs + Hocuspocus over WebSocket) — the REST APIs cover everything *around* the document; live typing/sync is not wired yet.
- **Object storage** (S3/MinIO) for version blobs, the **diff engine**, and **export** serializers — these endpoints return placeholder content.
- **AI worker** (BullMQ + LLM) — `/ai/*` endpoints enqueue/poll with stubbed results.
- **Full dynamic approval chain** — single-gate approval works; the multi-step `approval_policies` / `approval_policy_steps` / `approval_step_events` flow (policy CRUD, step completion rule, out-of-order/duplicate-approval guards) is only partially wired.
- **`audit_log` on every state change** — only `assignments` and ownership transfer write audit rows today; the design's "Stage 3" wants every mutating endpoint (accept/reject/submit/approve…) to write audit in the same transaction.
- **Offline / reconnect catch-up** — intentionally deferred in PLATE v2; placeholder columns (`documents.offline_enabled`, `notifications.delivered`) remain.

**Bigger future work:**
- **Multi-org / team creation** — the `org_id` hook is ready; needs an org-selection/creation flow.
- **Separation-of-duties** and richer approval policies (per §12 of PLATE v2).

---

## 13. Appendix — the tables that power roles, orgs, ownership, and transfer

| Concern | Table(s) / column(s) | Role in the flow |
|---|---|---|
| Org membership | `users.org_id` | which tenant a user belongs to (set at signup) |
| Role definitions | `roles(id, org_id, name)`, `role_permissions(role_id, permission)` | what each role can do (seeded once per org) |
| Role grants | `assignments(id, org_id, user_id, role_id, scope_type, scope_id)`, `UNIQUE(user_id, scope_type, scope_id)` | who has which role on which folder/document |
| Hierarchy / inheritance | `documents.folder_id`, `folders.parent_folder_id` | the path the `authorize` walk climbs |
| First role on create | a new `assignments` row (scope = the new folder/document) | creator-owns |
| Ownership transfer | upserted document-scoped `assignments` rows + an `audit_log` row | handover |
| Accountability | `audit_log(org_id, actor_id, document_id, action, target_type, target_id, meta, created_at)` | who did what |

*No schema change was required to support any of the above — these are all PLATE v2 tables used as designed.*
