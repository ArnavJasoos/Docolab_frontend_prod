# Docolab — RBAC (Roles, Permissions & Authorization)

The single reference for how access control works in Docolab: the roles, what each
permission unlocks, how a request is authorized, and how scopes/inheritance work.

---

## 1. The model in one picture

```
User ──(Assignment: "this user has ROLE on this SCOPE")──> Role ──> Permissions (data)
                              │                                         │
                       scope = a folder, a document, or "org"     e.g. can_edit_direct
```

Three moving parts:

- **Role** — a *named bundle of permissions* (e.g. `editor`). There is a **fixed set of 4** per org.
- **Permission** — a single capability string (e.g. `can_edit_direct`). Permissions live in the `role_permissions` table as **data**, not in code — so guards never hard-code role names, only permissions.
- **Assignment** — grants a user a role **on a specific scope** (a folder, a document, or the whole org). One row in `assignments` = "user U has role R on scope S".

A user can therefore be an `editor` on one folder, a `viewer` on a document, and have no role elsewhere — access is always **scoped**.

---

## 2. The 9 permissions (what each one unlocks)

| Permission | What it gates |
|---|---|
| `can_view_history` | **Read access** — open a document, list versions, read per-document audit & approval status; also required to **star** (bookmark) a doc |
| `can_edit_direct` | **Write directly** — create a document in a folder, rename/move/trash a document, create nested folders, restore a version section |
| `can_suggest` | Propose **tracked changes** (suggestions) and add **comments** |
| `can_resolve_suggestion` | **Accept/reject** suggestions; resolve comment threads |
| `can_submit_for_approval` | **Start** the approval workflow (freeze a submission snapshot, move the doc to `pending_approval`) |
| `can_give_final_approval` | Approve/reject in the **single-owner gate** (a document with no policy attached) |
| `can_approve_level` | Approve **one step** of a multi-step approval chain (policy attached) |
| `can_manage_approval_policy` | Create/edit **approval policies** and attach/detach them on a document |
| `can_manage_members` | Grant/revoke roles (`assignments`), delete documents/folders, transfer ownership; **on the `org` scope this makes you the org admin** (edit users, read the org-wide audit log) |

---

## 3. The roles (fixed set of 4) and their permissions

| Permission \ Role | **viewer** | **editor** | **approver** | **owner** |
|---|:--:|:--:|:--:|:--:|
| can_view_history | ✅ | ✅ | ✅ | ✅ |
| can_suggest | | ✅ | ✅ | ✅ |
| can_edit_direct | | ✅ | ✅ | ✅ |
| can_submit_for_approval | | ✅ | ✅ | ✅ |
| can_resolve_suggestion | | | ✅ | ✅ |
| can_give_final_approval | | | ✅ | ✅ |
| can_approve_level | | | ✅ | ✅ |
| can_manage_approval_policy | | | | ✅ |
| can_manage_members | | | | ✅ |

Read it as a ladder of trust: **viewer** (read) → **editor** (write + submit) → **approver** (write + submit + review/approve) → **owner** (everything, incl. members & policies).

**What each role is for, plainly:**
- **viewer** — can only read/open the document (and bookmark it).
- **editor** — writes content directly, proposes suggestions, and can **submit its own work for approval**. Cannot resolve suggestions or approve.
- **approver** — a reviewer/gatekeeper that can **also edit directly**, submit, resolve suggestions, and **approve** (both the single gate and chain steps). Cannot manage members or policies.
- **owner** — full control of the document/scope, including managing members (assignments) and approval policies. The document's creator becomes its owner automatically (see §6).

---

## 4. How a request is authorized (the one choke-point)

Every mutating endpoint calls **`require_permission(db, user_id, permission, scope_type, scope_id)`** (in `app/services/auth_service.py`). It raises **403** unless the user holds that permission on that scope. Internally:

```
require_permission ──> authorize ──> resolve_role (the scope walk)
                          │
                          └─ does the resolved role grant `permission`? (role_permissions lookup)
```

1. **`resolve_role`** finds the user's **effective role** on the scope by walking up the hierarchy until it finds an assignment:
   ```
   document  →  its folder  →  parent folder  →  … (root)
   org       →  (terminal — no walk)
   ```
   The **first** assignment found wins. A role on a folder is therefore **inherited** by every document inside it; a role placed **directly on a document overrides** the inherited one.
2. **`authorize`** checks whether that resolved role has the requested permission (a `role_permissions` lookup).
3. **`require_permission`** turns "no" into an HTTP **403**.

Permissions are **data**, so changing what a role can do is a row change in `role_permissions` — no code edits, and every guard updates at once.

---

## 5. Scopes & inheritance — a worked example

```
Folder "Engineering"   ── Alice = editor (assignment at folder scope)
   └── Document "Spec"  ── Bob   = viewer (assignment at document scope)
```
- **Alice** has no direct role on "Spec", so the walk goes Spec → Engineering and finds `editor` → she can edit "Spec".
- **Bob** has a direct `viewer` role on "Spec", which is found first → he can only read it, even though he might have a higher role on the folder.
- **Org scope** is separate and terminal: an `org`-scoped assignment is the **org admin** signal; it is *not* reached by walking up from a folder/document (so being an owner of one folder never makes you an org admin).

---

## 6. Bootstrapping & org admin

- **Creator-owns:** when a user creates a document (or folder), they are automatically granted the `owner` role on it (a document/folder-scoped assignment). This solves the chicken-and-egg of "who can grant the first role" and lets a junior who creates a doc own and later hand it off.
- **Org admin:** an explicit **`org`-scoped** assignment of a role with `can_manage_members` (the seeded admin gets this). It is deliberately **not** inferred from folder/document ownership — otherwise creator-owns would make everyone an admin. The org admin can manage members org-wide, manage policies, and read the org-wide audit log.
- **Seed:** a fresh database seeds the 4 roles + their permissions, one admin owner (`admin@acme.com`), a root folder, and the admin's folder- and org-scoped owner assignments. It runs **once** (guarded), so editing the seed only affects brand-new orgs — existing orgs are reconciled by Alembic migrations (e.g. `0005_role_perms`).

---

## 7. How RBAC drives the approval workflow

Approval is just more permission checks layered on the same model:

- **Submit:** `can_submit_for_approval` (editor/approver/owner) freezes a submission and snapshots the document's policy onto that version.
- **Single owner gate** (no policy attached): approving/rejecting needs `can_give_final_approval` (approver/owner).
- **Multi-step chain** (policy attached): each step names a **required role** + `min_approvals`. To clear a step you must (a) have that step's role as your *effective role on the document*, (b) hold `can_approve_level`, and (c) be a **distinct** approver from others on that step. Steps must complete **in order**; the baseline advances only when the final step is satisfied. (A step's role must be one that has `can_approve_level` — i.e. `approver` or `owner`.)

See `CURRENT_STATE.md` / the approval-policy endpoints for the full chain mechanics.

---

## 8. What changed in this revision (v3 role model)

| Change | Why |
|---|---|
| **`editor` gained `can_submit_for_approval`** | An editor that can change a document should be able to submit its own work for review (no longer needs an approver/owner to kick it off). |
| **`approver` gained `can_edit_direct`** | Approvers are reviewers who can now also make direct edits/fixes, not just gate. |
| **`suggester` role removed** | Redundant — direct editing plus the suggestion **review** flow (`can_suggest` + `can_resolve_suggestion`) already cover "propose, then approve". Removed from the seed, the `ownership.demote_to` choices, and existing orgs (migration `0005_role_perms` drops the role and any assignments using it). |

Roles are now exactly: **owner / approver / editor / viewer**.

> **Customizing further:** there is intentionally **no API to create roles or edit permissions** (only `GET /roles`). The 4 roles are seeded; to add tiers (e.g. for a 4-distinct-level approval chain) or change a role's permissions you edit the seed + add a migration (like `0005`). A future roles-admin API could expose this to org admins.

---

## 9. Quick how-to

```text
See the roles:            GET  /api/roles
Grant a role:             POST /api/assignments   { user_id, role_id, scope_type, scope_id }
Revoke a role:            DELETE /api/assignments/{id}      (blocked if it's the last owner of a scope)
Check a permission:       GET  /api/documents/{id}/authorize-check?permission=can_edit_direct
Transfer ownership:       POST /api/documents/{id}/transfer-ownership { to_user_id, demote_to }
```
`scope_type` is `"folder"`, `"document"`, or `"org"`; `demote_to` is one of `approver | editor | viewer`.
