# RBAC Enforcement + Audit Logging — Architecture, Design & Workflow

This documents the state of the codebase **after** the RBAC-enforcement + audit feature was added. It explains what changed, how it works, and how to use the RBAC model to build a multi-level approval hierarchy.

> **Headline:** this change adds **no new tables, no new columns, and no new endpoints.** It wires the two governance mechanisms the schema already had — the `authorize()` role-walk and the `audit_log` table — into **every state-changing endpoint**. It's pure enforcement + accountability, layered onto the existing 18-table, 51-endpoint API.

---

## 1. What changed (summary)

| Concern | Before | After |
|---|---|---|
| **RBAC enforcement** | `authorize()` existed; guards were applied only on assignments, suggestions, comments, recommendations, versions, ownership. `folders`, `documents`, `users` mutations were **unguarded** (any org member could act anywhere). | Every state-changing endpoint runs a permission guard before mutating. |
| **Audit** | `audit_log` table + read endpoint existed; only `assignments` and `ownership` wrote rows. | **Every** state-changing endpoint writes an `audit_log` row in the same transaction. |
| **Schema** | 18 tables | **18 tables (unchanged)** |
| **Endpoints** | 51 | **51 (unchanged)** |

**Two reusable helpers** were introduced so the logic lives in one place:
- `app/services/auth_service.py` → **`require_permission(db, user_id, permission, scope_type, scope_id)`** — the RBAC guard (raises 403).
- `app/services/audit_service.py` (new) → **`record_audit(db, *, org_id, actor_id, action, target_type, target_id, document_id, meta)`** + an **`AuditAction`** vocabulary class.

---

## 2. RBAC — how enforcement works

### The engine (unchanged)
`authorize()` resolves a user's effective role on a scope by walking **document → its folder → parent folders**, returning the first `assignments` row it finds, then checking that row's role against `role_permissions`. A role granted on a folder is **inherited** by its documents; a role granted directly on a document **overrides** the inherited one (document scope is checked first).

### The guard (new)
`require_permission(...)` is a thin wrapper over `authorize()` that raises **403** when the permission is absent. Every mutating endpoint calls it after fetching the resource and before changing state:
```python
await require_permission(db, current_user.id, "can_edit_direct", "folder", folder_id)
```

### The guard matrix (which permission, on which scope)

| Endpoint | Permission required | Scope | Notes |
|---|---|---|---|
| `POST /folders` (root, no parent) | — *(any logged-in member)* | — | **bootstrap entry point**; creator becomes owner |
| `POST /folders` (nested) | `can_edit_direct` | parent folder | |
| `PATCH /folders/:id` | `can_edit_direct` | the folder | + new parent if moved |
| `DELETE /folders/:id` | `can_manage_members` | the folder | destructive → owner-level |
| `POST /documents` | `can_edit_direct` | target folder | creator becomes owner |
| `PATCH /documents/:id` | `can_edit_direct` | the document | + destination folder if moved |
| `DELETE /documents/:id` | `can_manage_members` | the document | soft delete; owner-level |
| `PATCH /users/:id` | self-only | — | see §4 |
| *(already guarded)* assignments, suggestions, comments, recommendations, versions, ownership | as before | | unchanged |

### The bootstrap nuance (why root creation stays open)
If folder/doc creation were fully guarded, a brand-new user (who owns nothing yet) could never create anything → permanent lock-out. So **root-folder creation is intentionally open to any logged-in member**: it's the entry point that lets a new user create their own workspace and — via **creator-owns** — become its owner. From that point, every nested action is properly guarded. A fresh user: signup → create root folder (open, becomes owner) → create docs in it (owner has `can_edit_direct`) → all subsequent guards pass; a stranger to that folder gets **403**.

---

## 3. Audit — how logging works

### The store (unchanged)
`audit_log(org_id, actor_id, document_id?, action, target_type, target_id?, meta, created_at)` — append-only; surfaced read-only via `GET /documents/:id/audit` (guarded by `can_view_history`).

### The writer (new)
`record_audit(...)` queues one row with `db.add()` (synchronous — no DB round-trip). The endpoint's existing single `await db.commit()` persists the audit row **in the same transaction** as the action, so an action can never be committed without its audit row (or vice-versa).

### Action vocabulary (what each endpoint records)

| Module | Endpoint(s) | `action` | `target_type` |
|---|---|---|---|
| auth | signup | `user_signup` | user |
| users | patch | `user_update` | user |
| assignments | create / delete | `role_change` / `role_revoke` | assignment |
| ownership | transfer | `ownership_transfer` | document |
| folders | create / patch / delete | `folder_create` / `folder_update` / `folder_delete` | folder |
| documents | create / patch / delete | `document_create` / `document_update` / `document_delete` | document |
| suggestions | create / accept / reject | `suggestion_create` / `resolve_suggestion` / `reject_suggestion` | suggestion |
| comments | create | `comment_create` | comment |
| recommendations | create / patch / respond | `recommendation_create` / `recommendation_update` / `recommendation_response` | recommendation(_response) |
| versions | submit / approve / reject / restore | `submit` / `approve` / `reject` / `restore` | version |
| ai | apply-to-recommendation | `ai_apply` | suggestion |

`document_id` is set for document-scoped actions (so they appear in that document's audit feed) and left null for folder/user actions. `meta` carries the detail (changed fields, decision, reason, version no, …).

*Not audited (by design):* pure reads (GET), `login`/`refresh`/`logout` (session, not governance), and `notifications` read-state toggles (personal, not governance).

---

## 4. User management — the self-only rule (the nuance)

`PATCH /users/:id` has **no folder/document scope**, so the role-walk can't answer "may I edit this user." The rule is:
- **Editing your own profile** (`id == current_user.id`) → allowed.
- **Editing anyone else** → **403**.

**Why not "org-admin can edit others"?** An org-admin would need an **org-level** capability, but the assignment model is scoped to folders/documents only. Critically, because of **creator-owns**, *every* user owns their own root folder and therefore holds `can_manage_members` *somewhere* — so "has `can_manage_members` anywhere" would make **everyone** an admin, which is meaningless. A correct org-admin needs a dedicated org-level role/flag, which is **future work**. Until then, self-only is the safe, simple, correct v1 rule. (To later allow admins: add an org-admin concept and branch `if not self and not is_org_admin: 403`.)

---

## 5. Workflow changes (what users will notice)

- **Authorization is now enforced on content + profiles.** Creating a doc in a folder you can't edit, renaming/deleting others' folders/docs, or editing another user's profile now returns **403** (previously allowed). The owner of a scope (and roles inherited down the folder tree) still works exactly as before.
- **The audit log is now populated.** `GET /documents/:id/audit` returns a real, ordered trail of every governance action on that document (create, suggestion resolve/reject, submit/approve/reject, ownership transfer, …).
- **No URL or request/response shape changed.** Existing clients keep working; they just get 403s where they previously (incorrectly) succeeded.

---

## 6. Files changed

- **New:** `app/services/audit_service.py` (record_audit + AuditAction); `backend/test_rbac_audit.py` (rigorous RBAC + audit tests).
- **Guards + audit added:** `app/api/folders.py`, `app/api/documents.py`, `app/api/users.py`.
- **Audit added (guards already present):** `app/api/suggestions.py`, `app/api/comments.py`, `app/api/recommendations.py`, `app/api/versions.py`, `app/api/ai.py`, `app/api/auth.py` (signup).
- **Helper added:** `app/services/auth_service.py` (`require_permission`).
- **Unchanged (already conformant):** `app/api/assignments.py`, `app/api/ownership.py`.
- **Test fix:** `test_person_a_endpoints.py` (canonical `submit-for-approval` URL).
- **No change:** `database_models.py`, any migration, `main.py` routing.

---

## 7. Building a multi-level approval hierarchy with this RBAC model

There are **two cooperating layers**: the **permission tree** (who can do what, via folders + scoped roles) and the **approval chain** (the ordered sign-off, via the approval-policy tables). RBAC powers both.

### Layer A — the permission/org tree (folders + scoped roles + inheritance)
Folders nest (`parent_folder_id`), and roles **inherit down** the tree, so you model an org hierarchy by assigning **owners at different depths**:
```
Workspace (root)            owner: Org Lead
└── Engineering             owner: Eng Director        (can manage everything under Engineering)
    └── Platform Team       owner: Team Lead           (manages the Platform subtree)
        └── design-doc.md    editor: ICs, viewer: others
```
- The **Eng Director** (owner of `Engineering`) inherits authority over everything inside it, and — holding `can_manage_members` there — can grant roles within that subtree.
- The **Team Lead** (owner of `Platform Team`) manages just that subtree and can delegate further.
- A role granted directly on `design-doc.md` **overrides** the inherited folder role for that one document.

So the *delegation* hierarchy = scoped `owner`/`editor`/etc. assignments at successive folder levels, resolved by the same `authorize()` walk.

### Layer B — the ordered approval chain (approval policies)
For multi-step sign-off ("team lead → dept head → owner must each approve before the baseline moves"), the schema has three tables (already present):
- **`approval_policies`** — a named chain attached to a document (`documents.approval_policy_id`).
- **`approval_policy_steps`** — the ordered rungs; each step requires a **role** (`required_role_id`) and `min_approvals`.
- **`approval_step_events`** — the append-only ledger of who approved which step on a given submission.

Steps name a **role, not a person** — so "step 2 = dept_head" resolves at approval time against the live `assignments` (whoever currently holds that role on the scope), via the *same* RBAC walk. The `approve` endpoint records an `approval_step_events` row per step and **advances the baseline (writes the `approval_markers` row) only when the final step completes**; a NULL policy = today's single owner-gate.

### How the two combine into a tree
1. Build the **org structure** with folders + scoped owner/editor assignments (Layer A).
2. Define an **approval policy** whose steps reference roles that exist at the right scopes (e.g. step1 `team_lead`, step2 `dept_head`, step3 `owner`), and attach it to the document/folder (Layer B).
3. At approval, each step is satisfied by **whoever holds that role on that scope** (resolved via RBAC), and the baseline only moves when the chain is complete.

**Implementation status:** Layer A (scoped roles + inheritance) is fully built and enforced by this change. Layer B's tables exist and `approve`/`reject` record step events, but the **multi-step completion rule** (advance only when *all* steps' `min_approvals` are met, plus out-of-order/duplicate-approval guards) is **not yet fully wired** in `versions.py` — that's the governance work that finishes the multi-level approval tree (owned by the versioning module).

---

## 8. Validation

Run against a Postgres DB with the server up:
```
python test_rbac_audit.py        # guards (403/allow), bootstrap, self-only, audit trail, append-only
python test_new_endpoints.py     # core CRUD still works for owners
python test_person_a_endpoints.py# full collaboration + ownership workflow
python test_flow.py              # RBAC resolution demo
```
This feature was validated **twice** end-to-end against a live Postgres (a throwaway DB): all four suites pass, including the new RBAC edge cases (stranger → 403 on every foundation mutation, owner allowed, move-into-unowned-folder blocked, user self-only) and the audit assertions (`document_create`/`suggestion_create`/`resolve_suggestion` present, audit read 403 for non-viewers, DELETE on the audit path → 405 append-only). 51 endpoints, no route conflicts, app imports clean.
