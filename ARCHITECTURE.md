git # Docolab — Architecture, Design & Workflow
**Last updated:** 2026-06-18  
**Active branch:** `feature/governance-integration-fixes`  
**Schema migration:** `0002_add_starred_trashed_is_resolved` (current head)

---

## 1. System Overview

Docolab is a collaborative document platform built around a **governance-first** principle:
the editor is a replaceable surface; the real product is RBAC, approval workflows,
version history, and a complete audit trail.

```
┌──────────────────────────────────────────────────────────────┐
│  Browser — Next.js 16 + React 19                            │
│  Plate (Slate.js) editor  ·  Document browser  ·  Auth UI   │
  ├──────────────────────────────────────────────────────────────┤
│  Sync Layer — NOT YET BUILT                                 │
│  Hocuspocus (Node.js WebSocket)  ·  Yjs CRDT             │
├──────────────────────────────────────────────────────────────┤
│  REST API — FastAPI (Python 3.12)                           │
│  JWT auth  ·  RBAC  ·  Approval  ·  Versions  ·  Export    │
├──────────────────────────────────────────────────────────────┤
│  Persistence                                                │
│  PostgreSQL (metadata + state)  ·  S3/MinIO (blobs)        │
├──────────────────────────────────────────────────────────────┤
│  AI Worker — NOT YET BUILT                                  │
│  Redis + BullMQ  ·  LLM API behind LLMPort                 │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Database Schema — 18 Tables

> **Design rule:** PostgreSQL stores metadata, state, and pointers only.
> Live document content lives in Yjs/Hocuspocus (`yjs_doc_key`).
> Approved version blobs live in S3 (`s3_key`). Postgres rows point at them.

### Group A — Identity & Access

| Table | Key columns | Purpose |
|---|---|---|
| `users` | `id`, `email`, `password_hash`, `display_name`, `status` | Who can log in. Never hard-deleted — use `status=disabled`. |
| `roles` | `id`, `name` (owner/approver/editor/suggester/viewer) | Fixed role set per org. |
| `role_permissions` | `role_id`, `permission` (text) | A role is literally a set of permission strings. |
| `assignments` | `user_id`, `role_id`, `scope_type`, `scope_id` | Scoped role grants — a user has a role *on a folder or document*, never globally. UNIQUE `(user_id, scope_type, scope_id)`. |

**Permission strings in use:**
`can_edit_direct`, `can_suggest`, `can_resolve_suggestion`, `can_submit_for_approval`,
`can_give_final_approval`, `can_approve_level`, `can_manage_approval_policy`,
`can_view_history`, `can_manage_members`

---

### Group B — Content Organisation

| Table | Key columns | Purpose |
|---|---|---|
| `folders` | `id`, `parent_folder_id` (NULL = root), `name`, `created_by` | Self-referencing tree of nestable folders. |
| `documents` | See below | The hinge of the whole schema. |

#### `documents` — full column list *(updated in migration 0002)*

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid PK | — | Also the Hocuspocus document name |
| `org_id` | uuid | — | Tenant hook |
| `folder_id` | uuid FK→folders | — | Location |
| `title` | text | — | Display name |
| `yjs_doc_key` | text | — | Bridge to Yjs live content |
| `schema_version` | int | 1 | Slate node schema version |
| `status` | text | `working` | `working` \| `pending_approval` |
| `current_version_no` | int | 0 | Increments on each approval |
| `offline_enabled` | bool | false | Deferred offline feature flag |
| `starred` | bool | **false** | **NEW (0002)** — user bookmark flag |
| `trashed` | bool | **false** | **NEW (0002)** — recycle-bin soft-move |
| `approval_policy_id` | uuid FK→approval_policies NULL | NULL | NULL = single owner gate |
| `created_by` | uuid FK→users | — | Creator |
| `created_at` / `updated_at` | timestamptz | now() | Audit |

> **`starred` vs `trashed` vs `status` vs DELETE:**
> - `starred` = personal bookmark, has no effect on governance.
> - `trashed` = user moved to recycle bin. Trashed documents cannot be submitted for approval or trashed while pending (server enforces both).
> - `status` = governance state (`working` / `pending_approval`). Managed by the approval workflow, not the user directly.
> - `DELETE /documents/:id` = admin-level hard soft-delete (`status=deleted`). Separate from trash.

---

### Group C — Collaboration & Review

| Table | Key columns | Purpose |
|---|---|---|
| `suggestions` | `document_id`, `author_id`, `type`, `anchor` (jsonb), `status` | Pending tracked changes. `anchor` is a Yjs relative position. |
| `comments` | `document_id`, `author_id`, `body`, `is_resolved`, `parent_comment_id` | Threaded discussion. See below. |
| `edit_attributions` | `document_id`, `author_id`, `type`, `anchor` | Per-region event history (append-only). |
| `notifications` | `user_id`, `document_id`, `type`, `payload`, `delivered`, `read_at` | Approval events for in-app bell. |

#### `comments` — updated column *(migration 0002)*

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | uuid PK | — | Maps to Plate comment mark id |
| `org_id` | uuid | — | |
| `document_id` | uuid FK→documents | — | |
| `suggestion_id` | uuid FK→suggestions NULL | NULL | Linked suggestion if any |
| `anchor` | jsonb NULL | NULL | Yjs relative position for range comments |
| `author_id` | uuid FK→users | — | |
| `body` | text | — | Comment text |
| `is_resolved` | bool | **false** | **NEW (0002)** — thread resolved state |
| `parent_comment_id` | uuid FK→comments NULL | NULL | Threading (self-reference) |
| `created_at` | timestamptz | now() | |

> **`is_resolved` rules (enforced in `PATCH /comments/:id/resolve`):**
> - Only root comments (threads) can be resolved. Replies (`parent_comment_id IS NOT NULL`) return 400.
> - Only the comment author or a user with `can_resolve_suggestion` may toggle it.
> - Re-opening a resolved thread is allowed (set `is_resolved=false`).

---

### Group D — Versioning & Approval Governance

| Table | Key columns | Purpose |
|---|---|---|
| `versions` | `document_id`, `version_no`, `kind` (submission\|approved), `s3_key` | Snapshot pointer. |
| `approval_markers` | `document_id`, `approved_version_id`, `approved_by`, `approved_at` | Baseline pointer — latest row = current approved state. Append-only. |
| `approval_policies` | `name`, `is_active`, `created_by` | Named multi-step approval chain. |
| `approval_policy_steps` | `policy_id`, `step_no`, `required_role_id`, `min_approvals` | Ordered rungs of a chain. |
| `approval_step_events` | `version_id`, `policy_id`, `step_no`, `decision`, `actor_id` | Per-submission runtime ledger. Append-only. |
| `recommendations` | `version_id`, `author_id`, `anchor`, `body`, `status` | Owner notes on approve or reject. |
| `recommendation_responses` | `recommendation_id`, `author_id`, `body` | Team replies (append-only). |

### Group E — Audit

| Table | Key columns | Purpose |
|---|---|---|
| `audit_log` | `actor_id`, `document_id`, `action`, `target_type`, `target_id`, `meta` | Append-only record of every governance action. |

---

## 3. REST API Surface — 57 Routes

All routes under `/api`. JWT in `Authorization: Bearer`. Every mutating endpoint calls `authorize()`.

### Auth — `/api/auth`
| Method | Path | Status | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | ✅ Real | Create user, return JWT |
| POST | `/auth/login` | ✅ Real | Verify password, return JWT |
| GET | `/auth/me` | ✅ Real | Current user from JWT |
| POST | `/auth/refresh` | ❌ Stub | Refresh token (store not implemented) |
| POST | `/auth/logout` | ❌ Stub | Invalidate refresh token |

### RBAC — `/api/roles`, `/api/assignments`, `/api/users`
| Method | Path | Status |
|---|---|---|
| GET | `/roles` | ✅ Real |
| GET/POST/DELETE | `/assignments` | ✅ Real |
| GET/PATCH | `/users`, `/users/:id` | ✅ Real |

### Folders & Documents
| Method | Path | Status | Notes |
|---|---|---|---|
| GET/POST/PATCH/DELETE | `/folders`, `/folders/:id` | ✅ Real | |
| POST | `/documents` | ✅ Real | Auto-grants owner role to creator |
| GET | `/documents?folder_id=` | ✅ Real | Metadata only |
| GET | `/documents/:id` | ✅ Real | |
| PATCH | `/documents/:id` | ✅ Real | title, folder_id, **starred**, **trashed** |
| DELETE | `/documents/:id` | ✅ Real | Sets `status=deleted` |

> **New PATCH fields (0002):**
> - `starred: bool` — toggles bookmark. No governance restriction.
> - `trashed: bool=true` — blocked if `status=pending_approval` (409 Conflict).
> - `trashed: bool=false` — always allowed (restore from trash).

### Suggestions & Comments
| Method | Path | Status | Notes |
|---|---|---|---|
| GET/POST | `/documents/:id/suggestions` | ✅ Real | |
| POST | `/suggestions/:id/accept` | ✅ Real | Writes edit_attributions |
| POST | `/suggestions/:id/reject` | ✅ Real | |
| GET/POST | `/documents/:id/comments` | ✅ Real | |
| **PATCH** | **`/comments/:id/resolve`** | **✅ Real (NEW)** | Toggle `is_resolved`. Author or resolver only. Root comments only. |

### Versioning & Approval
| Method | Path | Status | Notes |
|---|---|---|---|
| GET | `/documents/:id/versions` | ✅ Real | |
| GET | `/versions/:id` | 🟡 Stub | S3 URL placeholder |
| POST | `/documents/:id/submit-for-approval` | ✅ Real | **Blocked if `trashed=true` (409)** |
| GET | `/documents/:id/diff` | 🟡 Stub | Placeholder text |
| POST | `/versions/:id/approve` | ✅ Real | Single-gate + chain-aware |
| POST | `/versions/:id/reject` | ✅ Real | |
| POST | `/versions/:id/restore` | ✅ Real | |
| GET | `/versions/:id/approval-status` | ❌ Not built | |

### Approval Policies (§9.5a — dynamic chain)
| Method | Path | Status |
|---|---|---|
| GET/POST | `/approval-policies` | ❌ Not built |
| PATCH | `/approval-policies/:id` | ❌ Not built |
| PATCH | `/documents/:id/approval-policy` | ❌ Not built |

### Recommendations, Notifications, AI, Export, Audit
| Method | Path | Status |
|---|---|---|
| GET/POST/PATCH | `/versions/:id/recommendations` + responses | ✅ Real |
| GET/POST/POST | `/notifications`, `/:id/read`, `/read-all` | ✅ Real |
| POST/POST/GET | `/documents/:id/ai/suggest`, `/recommendations/:id/ai/apply`, `/ai/jobs/:id` | 🟡 Stub |
| GET/GET | `/documents/:id/export`, `/versions/:id/export` | 🟡 Stub |
| GET | `/documents/:id/audit` | ✅ Real |

---

## 4. Business Logic & Guard Rules

### RBAC enforcement flow
```
Request arrives
    │
    ▼
get_current_user() — decode JWT → load User from DB
    │
    ▼
authorize(db, user_id, permission, scope_type, scope_id)
    │
    ├── walk assignments WHERE user_id + scope matches
    ├── check role_permissions WHERE permission matches
    └── return (allowed: bool, role_name, via_scope)
    │
    ▼
Endpoint proceeds or raises HTTP 403
```

### Starred / Trashed guard matrix

| Action | `starred` | `trashed` | `status` | Result |
|---|---|---|---|---|
| Star any document | any | any | any | Always allowed |
| Trash a `working` document | any | false→true | `working` | Allowed |
| Trash a `pending_approval` document | any | false→true | `pending_approval` | **409 Conflict** |
| Restore from trash | any | true→false | any | Always allowed |
| Submit trashed document | any | true | any | **409 Conflict** |
| Submit starred document | any | false | `working` | Allowed |
| Approve/reject trashed doc | any | true | `pending_approval` | Not blocked (already in review) |

### Comment resolve guard matrix

| Actor | `parent_comment_id` | `can_resolve_suggestion` | Result |
|---|---|---|---|
| Comment author | NULL (root) | any | Allowed |
| Any user with `can_resolve_suggestion` | NULL (root) | true | Allowed |
| Any other user | NULL (root) | false | **403 Forbidden** |
| Anyone | NOT NULL (reply) | any | **400 Bad Request** |

### Approval workflow state machine

```
Document status: "working"
        │
        │  POST /documents/:id/submit-for-approval
        │  (requires can_submit_for_approval)
        │  (blocked if trashed=true)
        ▼
Document status: "pending_approval"
        │
        ├── POST /versions/:id/approve ──────────────────────────────┐
        │   (single gate: requires can_give_final_approval)           │
        │   (chain: requires step role + can_approve_level)           │
        │   ├── More steps remain → stay pending, notify next step    │
        │   └── Final step → materialize blob, write approval_marker  │
        │                     status = "working", version_no += 1 ──► │
        │                                                             ▼
        │                                                    Document status: "working"
        │                                                    (new baseline version)
        │
        └── POST /versions/:id/reject
            (any step — records recommendations, discards warm blob)
            status = "working"  (baseline unchanged)
```

---

## 5. Frontend Structure

### Pages
| Route | File | Purpose |
|---|---|---|
| `/` | `app/page.tsx` | Sign-up / sign-in |
| `/browser` | `app/browser/page.tsx` | Document list — filter, star, trash, create |
| `/editor?doc=:id` | `app/editor/page.tsx` | Full Plate editor view |

### Key components
| File | Role |
|---|---|
| `components/editor/plate-editor.tsx` | Assembles DocumentProvider + Plate editor + top bar + comments panel |
| `components/editor/editor-kit.tsx` | Full plugin stack (30+ Plate plugins) |
| `components/editor/editor-top-bar.tsx` | Title, share, version history, export buttons |
| `components/editor/comments-panel.tsx` | Right-side discussion thread panel |
| `lib/store/document-store.tsx` | React context — loads doc, auto-save, readOnly, ⌘S |

### API client layer (`lib/api/`)
| File | State | Wired to |
|---|---|---|
| `client.ts` | ✅ Real | Base fetch wrapper (Bearer token, ApiError) |
| `auth.ts` | ✅ Real | `/api/auth/signup`, `/login` |
| `versions.ts` | ✅ Real | `/api/documents/:id/versions`, submit, restore |
| `notifications.ts` | ✅ Real | `/api/notifications` |
| `ai.ts` | ✅ Real | `/api/documents/:id/ai/suggest` (backend stub) |
| `export.ts` | ✅ Real | `/api/documents/:id/export` (backend stub) |
| `documents.ts` | ❌ Mock | localStorage — needs wiring + data model map |
| `comments.ts` | ❌ Mock | localStorage — needs wiring |
| `collaborators.ts` | ❌ Mock | localStorage — needs wiring |

### MSW mock layer
- `mocks/handlers.ts` — locked API contract (mirrors backend schemas)
- `mocks/browser.ts` + `server.ts` — browser worker + node server
- Enable: set `NEXT_PUBLIC_API_MOCKING=enabled` in `frontend/.env.local`

---

## 6. File → Function Map

### Backend

```
app/main.py
  startup_event()          — create tables, seed org/roles/admin/root-folder

app/core/config.py
  Settings.cors_origins_list   — parses CORS_ORIGINS env var

app/core/database.py
  get_db()                 — async session dependency (commit/rollback/close)

app/core/security.py
  get_password_hash()      — bcrypt hash
  verify_password()        — bcrypt verify
  create_access_token()    — JWT sign
  decode_access_token()    — JWT verify

app/services/auth_service.py
  authorize()              — RBAC: user→assignment→role→permission check

app/api/deps.py
  get_current_user()       — JWT decode → User from DB

app/api/auth.py
  signup()                 — POST /auth/signup
  login()                  — POST /auth/login
  me()                     — GET  /auth/me

app/api/documents.py
  create_document()        — POST /documents
  list_documents()         — GET  /documents?folder_id=
  get_document()           — GET  /documents/:id
  update_document()        — PATCH /documents/:id  [title, folder_id, starred, trashed]
  delete_document()        — DELETE /documents/:id

app/api/comments.py
  list_comments()          — GET  /documents/:id/comments
  create_comment()         — POST /documents/:id/comments
  resolve_comment()        — PATCH /comments/:id/resolve  [NEW]

app/api/versions.py
  list_versions()          — GET  /documents/:id/versions
  get_version()            — GET  /versions/:id
  submit_for_approval()    — POST /documents/:id/submit-for-approval
  get_diff()               — GET  /documents/:id/diff
  approve_version()        — POST /versions/:id/approve
  reject_version()         — POST /versions/:id/reject
  restore_version()        — POST /versions/:id/restore

app/api/suggestions.py
  list_suggestions()       — GET  /documents/:id/suggestions
  create_suggestion()      — POST /documents/:id/suggestions
  accept_suggestion()      — POST /suggestions/:id/accept
  reject_suggestion()      — POST /suggestions/:id/reject

app/api/notifications.py
  get_notifications()      — GET  /notifications
  mark_read()              — POST /notifications/:id/read
  mark_all_read()          — POST /notifications/read-all

app/api/recommendations.py
  list_recommendations()   — GET  /versions/:id/recommendations
  create_recommendation()  — POST /versions/:id/recommendations
  update_recommendation()  — PATCH /recommendations/:id
  list_responses()         — GET  /recommendations/:id/responses
  create_response()        — POST /recommendations/:id/responses

app/api/ai.py
  suggest()                — POST /documents/:id/ai/suggest
  apply_recommendation()   — POST /recommendations/:id/ai/apply
  get_job_status()         — GET  /ai/jobs/:job_id

app/api/export.py
  export_document()        — GET  /documents/:id/export
  export_version()         — GET  /versions/:id/export

app/api/audit.py
  get_audit_log()          — GET  /documents/:id/audit

app/api/folders.py
  list_folders()           — GET  /folders
  create_folder()          — POST /folders
  update_folder()          — PATCH /folders/:id
  delete_folder()          — DELETE /folders/:id

app/api/assignments.py
  create_assignment()      — POST /assignments
  list_assignments()       — GET  /assignments
  delete_assignment()      — DELETE /assignments/:id

app/api/roles.py
  list_roles()             — GET  /roles

app/api/users.py
  list_users()             — GET  /users
  update_user()            — PATCH /users/:id

app/api/ownership.py
  transfer_ownership()     — POST /documents/:id/transfer-ownership
```

---

## 7. Migration History

| File | What it does |
|---|---|
| `0001_initial_initial_schema_18_tables.py` | Full 18-table initial schema |
| `0002_add_starred_trashed_is_resolved.py` | Adds `documents.starred`, `documents.trashed`, `comments.is_resolved` |

Apply:
```bash
cd backend
alembic upgrade head
```

Rollback:
```bash
alembic downgrade 0001_initial
```

---

## 8. Complete Workflow Diagrams

### Sign-up & First Document

```
Browser                     FastAPI                    PostgreSQL
  │                            │                            │
  │── POST /auth/signup ───────►│                            │
  │   {name, email, password}  │── INSERT users ───────────►│
  │                            │── INSERT assignments ──────►│  (owner of root folder)
  │◄── {access_token} ─────────│                            │
  │                            │                            │
  │── POST /documents ─────────►│                            │
  │   Bearer: <token>          │── INSERT documents ────────►│
  │   {folder_id, title}       │── INSERT assignments ──────►│  (owner of new doc)
  │◄── DocumentResponse ───────│                            │
```

### Star / Trash a Document

```
PATCH /documents/:id   {starred: true}
    │
    ▼
get_document (check org_id matches)
    │
    ▼
data.starred is not None → doc.starred = True
    │
    ▼
db.commit() → return DocumentResponse (starred=true)

PATCH /documents/:id   {trashed: true}
    │
    ▼
check doc.status != "pending_approval"   ← 409 if pending
    │
    ▼
doc.trashed = True → db.commit()
```

### Resolve a Comment Thread

```
PATCH /comments/:id/resolve   {is_resolved: true}
    │
    ▼
load comment (check org_id)
    │
    ▼
comment.parent_comment_id IS NOT NULL?  ← 400 (replies can't be resolved)
    │
    ▼
current_user == comment.author_id  OR  has can_resolve_suggestion?  ← 403 if neither
    │
    ▼
comment.is_resolved = True → db.commit()
```

---

## 9. What is Built vs. Pending

### Built and working (real DB)
- Auth (signup, login, me)
- Full RBAC (roles, assignments, authorize guard)
- Folders + Documents CRUD (including starred, trashed, conflict guard)
- Suggestions (create, accept, reject)
- Comments (create, list, **resolve** — new)
- Recommendations + response threads
- Versions (list, submit, approve, reject, restore — trashed guard added)
- Notifications (list, mark read)
- Audit log
- CORS middleware, .env loading, route mounts

### Stub (endpoint exists, returns placeholder)
- `GET /versions/:id` — fake S3 signed URL
- `GET /documents/:id/diff` — no real Slate diff
- `GET/GET /documents/:id/export`, `/versions/:id/export` — no Plate serializer
- `POST /documents/:id/ai/suggest` — fake job ID
- `POST /recommendations/:id/ai/apply` — fake job ID
- `GET /ai/jobs/:job_id` — hardcoded "completed"

### Not yet built
- `GET /versions/:id/approval-status`
- Approval policy CRUD (`/approval-policies`, `PATCH /documents/:id/approval-policy`)
- `POST /auth/refresh` + `POST /auth/logout`
- Hocuspocus WebSocket server (`/collab/:doc_id`)
- SSE push notifications (`/events`)
- Redis + BullMQ AI worker
- Real S3/MinIO integration

### Frontend still on localStorage mock
- `documents.ts` (8 functions) — needs `starred`/`trashed` data model reconciliation first
- `comments.ts` (5 functions) — needs Plate `TDiscussion` ↔ flat Comment mapping
- `collaborators.ts` (6 functions) — needs role name mapping + `generalAccess` decision
