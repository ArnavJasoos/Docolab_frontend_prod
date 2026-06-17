# Teammate 1 — API Reference (the "20 dummy APIs")

This documents the endpoints **Teammate 1 owns**: the identity + content-organization spine — auth (signup/login/me), roles, assignments, folders, documents, users. It does **not** cover Person A's collaboration endpoints (suggestions/comments/recommendations/audit/ownership + auth refresh/logout) or Teammate 3's (versions/notifications/ai/export).

> **Count note:** the work-division doc calls this "20 APIs," but the table it lists only adds up to 19, while the **actual code** also has two bonus single-item reads (`GET /folders/:id`, `GET /users/:id`). So there are really **21 routes** here. All of them are documented below.

Audience: anyone wiring the frontend or testing the backend. Plain-English, accurate to the current code.

---

## 0. Things true for ALL these endpoints (read first)

- **Base URL (dev):** `http://localhost:8000/api`
- **Bodies are JSON** (`Content-Type: application/json`). **Who calls them ("source"):** the **frontend** (browser). **What they talk to ("target"):** a FastAPI route → SQLAlchemy → **PostgreSQL** tables (and the JWT layer for signup/login).
- **Auth:** every endpoint **except** `signup` and `login` needs the header `Authorization: Bearer <JWT>`. You get the JWT from signup/login. Missing/invalid → **401**.
- **Org isolation:** every query is filtered by your `org_id`; you only see your organization's data. In v1 there's a single shared org, so all signed-up users are in the same org.
- **Permissions — important:** only the **assignments** endpoints actually check a permission (`can_manage_members`). The folder, document, and user *write* endpoints currently check **only** that you're logged in and the row is in your org — they do **not** check a role (see §7). The one read helper for permissions is `GET /documents/:id/authorize-check`.
- **IDs:** UUID strings. **Timestamps:** ISO-8601 strings. **Errors:** `{ "detail": "<message>" }` with a status code; validation problems are **422**.
- **Legend:** `str` = text, `UUID` = id string, `| null` = nullable, `?x=` = query parameter.

### At a glance

| # | Method | Path | Purpose | Permission |
|---|---|---|---|---|
| 1 | POST | `/auth/signup` | create an account, get a token | none |
| 2 | POST | `/auth/login` | log in, get a token | none |
| 3 | GET | `/auth/me` | who am I | (auth) |
| 4 | GET | `/roles` | list roles + their permissions | (auth) |
| 5 | POST | `/assignments` | give a user a role on a scope | `can_manage_members` |
| 6 | GET | `/assignments?scope_type=&scope_id=` | list role grants on a scope | (auth) |
| 7 | DELETE | `/assignments/:id` | revoke a role grant | `can_manage_members` |
| 8 | POST | `/folders` | create a folder | (auth) → becomes owner |
| 9 | GET | `/folders` | list folders | (auth) |
| 10 | GET | `/folders/:id` | get one folder | (auth) |
| 11 | PATCH | `/folders/:id` | rename / move a folder | (auth) |
| 12 | DELETE | `/folders/:id` | delete an empty folder | (auth) |
| 13 | POST | `/documents` | create a document | (auth) → becomes owner |
| 14 | GET | `/documents?folder_id=` | list documents in a folder | (auth) |
| 15 | GET | `/documents/:id` | get one document | (auth) |
| 16 | PATCH | `/documents/:id` | rename / move a document | (auth) |
| 17 | DELETE | `/documents/:id` | soft-delete a document | (auth) |
| 18 | GET | `/documents/:id/authorize-check?permission=` | test a permission | (auth) |
| 19 | GET | `/users` | list org members | (auth) |
| 20 | GET | `/users/:id` | get one user | (auth) |
| 21 | PATCH | `/users/:id` | update a user profile | (auth) |

"(auth)" = logged-in + org check only, no specific role required.

---

## 1. Auth — accounts & login (`app/api/auth.py`)

### 1. POST `/api/auth/signup`
- **Purpose:** create a new account and immediately get a login token. In v1, the new user joins the **single shared org**.
- **Source → target:** frontend → writes one **`users`** row, then creates a JWT.
- **Request JSON:**
  ```json
  { "email": "alice@acme.com", "password": "secret123", "display_name": "Alice" }
  ```
- **Response JSON (201):**
  ```json
  {
    "user": {
      "id": "UUID", "email": "alice@acme.com", "display_name": "Alice",
      "avatar_color": "#7aa2f7", "status": "active", "created_at": "datetime"
    },
    "token": "<JWT access token>"
  }
  ```
- **Errors:** `409` if the email is already registered; `422` if the email is malformed.

### 2. POST `/api/auth/login`
- **Purpose:** exchange email + password for a token.
- **Source → target:** frontend → reads **`users`**, verifies the password hash, creates a JWT.
- **Request JSON:** `{ "email": "alice@acme.com", "password": "secret123" }`
- **Response JSON (200):** same shape as signup (`{ "user": {...}, "token": "..." }`).
- **Errors:** `401` wrong email/password; `403` if the account is disabled.

### 3. GET `/api/auth/me`
- **Purpose:** return the currently logged-in user (frontend uses it to confirm the token and show the profile).
- **Source → target:** frontend (with Bearer token) → reads **`users`** (via the token's user id).
- **Request:** none (token in header).
- **Response JSON (200):**
  ```json
  { "id": "UUID", "email": "str", "display_name": "str", "avatar_color": "str | null", "status": "active | disabled", "created_at": "datetime" }
  ```
- **Errors:** `401` no/invalid token.

---

## 2. Roles (`app/api/roles.py`)

### 4. GET `/api/roles`
- **Purpose:** list the roles in the system and what each one is allowed to do. The frontend uses this to populate role pickers and to know which `role_id` to send when assigning a role.
- **Source → target:** frontend → reads **`roles`** + **`role_permissions`**.
- **Response JSON (200):**
  ```json
  {
    "roles": [
      { "id": "UUID", "name": "owner",  "permissions": ["can_edit_direct", "can_suggest", "can_resolve_suggestion", "..."] },
      { "id": "UUID", "name": "editor", "permissions": ["can_edit_direct", "can_suggest", "can_view_history"] }
    ]
  }
  ```
- **Errors:** `401`.
- **Note:** role ids are UUIDs (seeded at startup). Always read them from here — don't hardcode role-id strings.

---

## 3. Assignments — who has which role where (`app/api/assignments.py`)

An "assignment" = a row saying *"user X has role Y on scope Z"*, where a scope is a folder or a document. This is the heart of permissions: your role on a document is found by looking at assignments on it (and on its parent folders).

### 5. POST `/api/assignments`
- **Purpose:** grant a user a role on a folder or document.
- **Source → target:** frontend → writes one **`assignments`** row **and** one **`audit_log`** row (`action: "role_change"`).
- **Request JSON:**
  ```json
  { "user_id": "UUID", "role_id": "UUID", "scope_type": "folder | document", "scope_id": "UUID" }
  ```
- **Response JSON (201):**
  ```json
  { "id": "UUID", "user_id": "UUID", "role_id": "UUID", "scope_type": "folder", "scope_id": "UUID" }
  ```
- **Permission:** `can_manage_members` on that scope (only owners have it).
- **Errors:** `403` (no permission); `400` (user/role doesn't exist, or scope target not found, or bad `scope_type`); `409` (that user already has an assignment on that scope); `401`.

### 6. GET `/api/assignments?scope_type=&scope_id=`
- **Purpose:** list everyone who holds a role on a given folder/document (and which role).
- **Source → target:** frontend → reads **`assignments`** joined to **`roles`**.
- **Query (required):** `scope_type` (`folder`|`document`), `scope_id` (UUID).
- **Response JSON (200):**
  ```json
  {
    "assignments": [
      { "id": "UUID", "user_id": "UUID", "role_id": "UUID", "role_name": "editor" }
    ]
  }
  ```
- **Errors:** `401`.

### 7. DELETE `/api/assignments/:id`
- **Purpose:** revoke a role grant.
- **Source → target:** frontend → deletes the **`assignments`** row and writes an **`audit_log`** row (`action: "role_revoke"`).
- **Response:** `204 No Content` (empty body).
- **Permission:** `can_manage_members` on that assignment's scope.
- **Errors:** `404` (assignment not found); `403`; `401`.

---

## 4. Folders (`app/api/folders.py`)

Folders are a nestable tree (a folder can have a `parent_folder_id`). They organize documents and are the main place roles are assigned (roles on a folder are inherited by everything inside it).

### 8. POST `/api/folders`
- **Purpose:** create a folder (root if `parent_folder_id` is null, otherwise nested).
- **Source → target:** frontend → writes one **`folders`** row, **and** (creator-owns) one **`assignments`** row making you the `owner` of the new folder.
- **Request JSON:** `{ "name": "Projects", "parent_folder_id": "UUID | null" }`
- **Response JSON (201):** `{ "id": "UUID", "name": "Projects", "parent_folder_id": "UUID | null", "created_by": "UUID" }`
- **Permission:** none beyond being logged in — but you automatically become **owner** of what you create.
- **Errors:** `400` (parent folder doesn't exist); `401`; `422` (missing name).

### 9. GET `/api/folders`
- **Purpose:** list all folders in your org (the navigation tree).
- **Source → target:** frontend → reads **`folders`** (org-filtered).
- **Response JSON (200):**
  ```json
  { "folders": [ { "id": "UUID", "name": "str", "parent_folder_id": "UUID | null", "created_by": "UUID", "created_at": "datetime" } ] }
  ```

### 10. GET `/api/folders/:id`
- **Purpose:** fetch one folder's metadata.
- **Response JSON (200):** `{ "id": "UUID", "name": "str", "parent_folder_id": "UUID | null", "created_by": "UUID" }`
- **Errors:** `404` (not found / not in your org); `401`.

### 11. PATCH `/api/folders/:id`
- **Purpose:** rename a folder and/or move it under a different parent.
- **Source → target:** frontend → updates the **`folders`** row.
- **Request JSON:** `{ "name": "str | null", "parent_folder_id": "UUID | null" }` (send only the fields you want to change).
- **Response JSON (200):** the updated folder object.
- **Errors:** `404` (folder); `400` (new parent doesn't exist); `401`.

### 12. DELETE `/api/folders/:id`
- **Purpose:** delete a folder — but only if it's empty.
- **Source → target:** frontend → deletes the **`folders`** row.
- **Response:** `204 No Content`.
- **Errors:** `404` (folder); `400` ("Cannot delete folder with children or documents"); `401`.

---

## 5. Documents (`app/api/documents.py`)

A document row holds **metadata only** — title, status, which folder it's in, and a `yjs_doc_key` pointing at where the live content lives (the actual text is in Yjs/Hocuspocus, not Postgres).

### 13. POST `/api/documents`
- **Purpose:** create a document inside a folder.
- **Source → target:** frontend → writes one **`documents`** row, **and** (creator-owns) one **`assignments`** row making you the `owner` of the new document.
- **Request JSON:** `{ "folder_id": "UUID", "title": "Q1 Roadmap" }`
- **Response JSON (201):**
  ```json
  {
    "id": "UUID", "folder_id": "UUID", "title": "Q1 Roadmap",
    "status": "working", "current_version_no": 0, "yjs_doc_key": "str",
    "created_by": "UUID", "created_at": "datetime", "updated_at": "datetime"
  }
  ```
- **Permission:** none beyond login — you become **owner** of what you create.
- **Errors:** `400` (folder doesn't exist); `401`; `422`.

### 14. GET `/api/documents?folder_id=`
- **Purpose:** list the documents in a folder (metadata only — never content).
- **Source → target:** frontend → reads **`documents`** by `folder_id`.
- **Query (required):** `folder_id`.
- **Response JSON (200):**
  ```json
  { "documents": [ { "id": "UUID", "title": "str", "status": "working | pending_approval | deleted", "current_version_no": 0, "created_by": "UUID" } ] }
  ```

### 15. GET `/api/documents/:id`
- **Purpose:** fetch one document's metadata (the live content arrives separately over the WebSocket).
- **Response JSON (200):** the full document object (same shape as create).
- **Errors:** `404` (not found / not in org); `401`.

### 16. PATCH `/api/documents/:id`
- **Purpose:** rename a document and/or move it to a different folder.
- **Source → target:** frontend → updates the **`documents`** row.
- **Request JSON:** `{ "title": "str | null", "folder_id": "UUID | null" }`
- **Response JSON (200):** the updated document object.
- **Errors:** `404` (document); `400` (target folder doesn't exist); `401`.

### 17. DELETE `/api/documents/:id`
- **Purpose:** delete a document. This is a **soft delete** — the row stays, its `status` becomes `"deleted"` (so history/audit are preserved).
- **Source → target:** frontend → updates the **`documents`** row (`status → "deleted"`).
- **Response:** `204 No Content`.
- **Errors:** `404`; `401`.

### 18. GET `/api/documents/:id/authorize-check?permission=`
- **Purpose:** ask the server "does the current user have permission X on this document?" The frontend uses this to gray out buttons (it's a convenience — the real enforcement happens on each action).
- **Source → target:** frontend → runs the permission walk over **`assignments` + `roles` + `role_permissions`** (document → folder → parents).
- **Query (required):** `permission` (e.g. `can_edit_direct`).
- **Response JSON (200):**
  ```json
  { "allowed": true, "resolved_role": "editor | null", "via_scope": "folder:UUID | document:UUID | null" }
  ```
  `resolved_role` = the role you were found to have; `via_scope` = where that role came from (the document itself, or which folder up the tree).
- **Errors:** `404` (document); `401`.

---

## 6. Users (`app/api/users.py`)

### 19. GET `/api/users`
- **Purpose:** list the members of your organization (with profile info). Used for member lists and people-pickers.
- **Source → target:** frontend → reads **`users`** (org-filtered).
- **Response JSON (200):**
  ```json
  { "users": [ { "id": "UUID", "email": "str", "display_name": "str", "avatar_color": "str | null", "status": "active | disabled", "created_at": "datetime" } ] }
  ```

### 20. GET `/api/users/:id`
- **Purpose:** fetch one user's profile.
- **Response JSON (200):** a single user object (same shape as `/auth/me`).
- **Errors:** `404` (not found / not in org); `401`.

### 21. PATCH `/api/users/:id`
- **Purpose:** update a user's display name, avatar color, or status (status is how you **soft-disable** an account — users are never hard-deleted).
- **Source → target:** frontend → updates the **`users`** row.
- **Request JSON:** `{ "display_name": "str | null", "avatar_color": "str | null", "status": "active | disabled | null" }`
- **Response JSON (200):** the updated user object.
- **Errors:** `404` (user); `400` (status must be `active` or `disabled`); `401`.

---

## 7. Things you might have missed (subtle but important)

- **Most write endpoints here have NO role check.** Only `POST/DELETE /assignments` enforce `can_manage_members`. Creating/renaming/deleting **folders and documents**, and editing **any user's profile**, currently require only a valid login + same-org — *any* org member can do them. The design says all state-changing endpoints should be permission-guarded, so this is a known gap to tighten later (e.g., guard `create_document` with `can_edit_direct` on the folder).
- **Creator-owns is an added behavior.** `POST /folders` and `POST /documents` now also write an `assignments` row making the creator the `owner`. (This was added on top of Teammate 1's originals to fix the "new user has no permissions" bootstrap.) So whoever creates a thing can immediately manage it.
- **`DELETE /documents/:id` is a soft delete** (sets `status = "deleted"`), not a real row removal — so the document still exists in the database and still appears in `GET /documents/:id` with `status: "deleted"`. `DELETE /folders/:id` is a **hard** delete but only for empty folders.
- **Only the assignments endpoints write to `audit_log`** (`role_change` / `role_revoke`). Folder/document/user changes are not audited yet.
- **`authorize-check` is read-only and advisory.** It tells the UI what to enable; it does not perform any action and is not a substitute for the server-side checks on the real endpoints.
- **The `Token` response includes the full user object plus the JWT.** After signup/login the frontend should store `token` (e.g. `localStorage`) and send it as `Authorization: Bearer <token>` on every later call.
- **Email uniqueness is global**, not per-org (signup returns `409` if the email exists anywhere).
- **Single shared org (v1).** `signup` puts everyone in one org (`DEFAULT_ORG_ID`); `org_id` is the hook for future multi-org support, but today there's one org and everyone in it can see each other via `GET /users`.
- **Request bodies accept string ids; responses return string ids + ISO datetimes** — same value on the wire either way, so the frontend always works with strings.
- **`yjs_doc_key`** on a document is just a pointer to where the live editable content lives (Yjs/Hocuspocus). These REST endpoints never carry the document's actual text — only metadata.
- **Routes mount at `/api/<module>`** for this set (`/api/auth/...`, `/api/folders/...`, etc.), so the URLs are clean. (Different from Teammate 3's versions/ai routers, whose URLs repeat the module name.)
