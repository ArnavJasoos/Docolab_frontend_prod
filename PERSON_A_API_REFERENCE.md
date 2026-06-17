# Person A (Teammate 2) — API Reference

This documents **only the endpoints I own** — the collaboration cluster plus the ownership-transfer endpoint we added together. It does **not** cover Teammate 1's (auth/users/folders/documents/assignments/roles) or Teammate 3's (versions/notifications/ai/export) endpoints, except where mine connect to their data.

Audience: anyone wiring the frontend, or testing the backend. Written to be read top to bottom once, then used as a lookup.

---

## 0. Things that are true for ALL my endpoints (read this first)

- **Base URL (dev):** `http://localhost:8000/api`
- **Transport:** plain HTTP, request and response bodies are **JSON** (`Content-Type: application/json`).
- **Who calls them ("source"):** the **frontend** (browser) is the normal caller. The *one* exception: `POST /documents/{id}/suggestions` is also called by the **AI worker** (it sends `origin: "ai"`). Nothing else is machine-to-machine.
- **What they talk to ("target"):** a FastAPI route handler → SQLAlchemy → **PostgreSQL** tables. A couple also touch the JWT layer. No endpoint of mine touches S3, Yjs/Hocuspocus, or the AI queue directly.
- **Authentication:** every endpoint except `refresh`/`logout` requires a header `Authorization: Bearer <JWT>`. You get the JWT from `POST /api/auth/login` or `/signup`. Missing/invalid token → **401**.
- **Authorization (permissions):** mutating endpoints run a permission check (`authorize`) that resolves your role on the document (walking document → its folder → parent folders) and confirms the role includes the required permission. Lacking it → **403**.
- **Org isolation:** every query is filtered by your `org_id`. You can only see/act on data in your own organization. Asking for something in another org looks the same as "not found" → **404**.
- **IDs:** all ids are **UUID strings** (e.g. `"b3dc5f32-f9d9-4433-b466-2a282413ac6a"`).
- **Timestamps:** ISO-8601 datetime strings (e.g. `"2026-06-16T10:30:00Z"`).
- **`anchor`:** a **JSON object** (not a string). It's a *Yjs relative position* — a pointer that says "where in the live document this attaches" and survives other people editing around it. The backend stores it as-is (JSONB) and never interprets it; the editor produces and consumes it.
- **Errors:** failures return `{ "detail": "<message>" }` with an HTTP status code (see each endpoint). Validation failures (wrong/missing fields, bad enum value) are **422** with a list describing the bad fields.
- **Quick legend:** `str` = text, `UUID` = id string, `dict` = JSON object, `| null` = may be null, `?x=` = query-string parameter.

### My endpoints at a glance

| # | Method | Path | Purpose | Permission |
|---|---|---|---|---|
| 1 | POST | `/auth/refresh` | new access token from a token | none |
| 2 | POST | `/auth/logout` | end a session (stub) | none |
| 3 | GET | `/documents/{id}/suggestions` | list a doc's suggestions | (read) |
| 4 | POST | `/documents/{id}/suggestions` | create a suggestion (human or AI) | `can_suggest` |
| 5 | POST | `/suggestions/{id}/accept` | accept a suggestion | `can_resolve_suggestion` |
| 6 | POST | `/suggestions/{id}/reject` | reject a suggestion | `can_resolve_suggestion` |
| 7 | GET | `/documents/{id}/comments` | list a doc's comments | (read) |
| 8 | POST | `/documents/{id}/comments` | post a comment | `can_suggest` |
| 9 | GET | `/versions/{id}/recommendations` | list owner notes on a version | (read) |
| 10 | POST | `/versions/{id}/recommendations` | create a recommendation | `can_give_final_approval` |
| 11 | PATCH | `/recommendations/{id}` | change a recommendation's status | `can_give_final_approval` |
| 12 | GET | `/recommendations/{id}/responses` | read the reply thread | (read) |
| 13 | POST | `/recommendations/{id}/responses` | reply (append-only) | `can_suggest` |
| 14 | GET | `/documents/{id}/audit` | read a doc's history | `can_view_history` |
| 15 | POST | `/documents/{id}/transfer-ownership` | hand a doc to another user | `can_manage_members` |

"(read)" = no specific permission, but you must be logged in and the resource must be in your org.

---

## 1. Auth — refresh & logout (`app/api/auth.py`)

> **Important honesty note:** these are **stubs**. The v1 database has no refresh-token table, so there's nothing to persist or revoke. They exist so the frontend has the right URLs and response shapes to build against; the real token-store logic comes later. They do **not** touch the database.

### 1. POST `/api/auth/refresh`
- **Purpose:** exchange a token for a brand-new access token (so a user stays logged in without re-entering a password).
- **Source → target:** frontend → JWT layer (`create_access_token`). No DB.
- **Request JSON:**
  ```json
  { "refresh_token": "<a JWT>" }
  ```
- **Response JSON (200):**
  ```json
  { "token": "<new JWT>", "token_type": "bearer" }
  ```
- **Errors:** `401` if the supplied token is invalid/expired.

### 2. POST `/api/auth/logout`
- **Purpose:** end the session. (Stub: just acknowledges; the frontend should delete its stored token.)
- **Source → target:** frontend → nothing (no DB).
- **Request JSON:**
  ```json
  { "refresh_token": "<a JWT>" }
  ```
- **Response JSON (200):**
  ```json
  { "success": true, "message": "Logged out" }
  ```

---

## 2. Suggestions — the inner review loop (`app/api/suggestions.py`)

A "suggestion" is a proposed change to a document (an insert/delete/etc.) that a reviewer later accepts or rejects. The editor draws it inline (green/red); **the backend owns the record** (who proposed it, its status, the audit).

### 3. GET `/api/documents/{id}/suggestions?status=`
- **Purpose:** list all suggestions on a document, newest-creation-last. Optionally filter by status.
- **Source → target:** frontend → reads the **`suggestions`** table.
- **Path:** `id` = document UUID. **Query (optional):** `status` = `pending` | `approved` | `rejected` | `orphaned`.
- **Response JSON (200):**
  ```json
  {
    "suggestions": [
      {
        "id": "UUID",
        "document_id": "UUID",
        "author_id": "UUID | null",     // null = AI-authored
        "origin": "human | ai",
        "type": "insert | delete | replace | format",
        "anchor": { },                   // Yjs relative position
        "status": "pending | approved | rejected | orphaned",
        "reason": "str | null",
        "resolved_by": "UUID | null",
        "resolved_at": "datetime | null",
        "created_at": "datetime"
      }
    ]
  }
  ```
- **Errors:** `401` no token; `404` document not found (or not in your org).

### 4. POST `/api/documents/{id}/suggestions`
- **Purpose:** record a new suggestion. **Same endpoint for humans and the AI worker** — `origin` tells them apart. If `origin` is `"ai"`, the stored `author_id` is null.
- **Source → target:** frontend **or** AI worker → writes one row to **`suggestions`**.
- **Request JSON:**
  ```json
  {
    "type": "insert | delete | replace | format",   // required
    "anchor": { },                                   // required (JSON object)
    "origin": "human | ai",                          // optional, default "human"
    "reason": "str"                                  // optional
  }
  ```
- **Response JSON (201):** a single suggestion object (same shape as in #3).
- **Permission:** `can_suggest`.
- **Errors:** `401`; `403` (no permission); `404` (doc); `422` (bad `type`/`origin`).

### 5. POST `/api/suggestions/{id}/accept`
- **Purpose:** accept a pending suggestion. Marks it approved, records who/when, and **writes an attribution row** (the "who changed what" history).
- **Source → target:** frontend → updates **`suggestions`** (status → `approved`, sets `resolved_by`, `resolved_at`) and inserts one **`edit_attributions`** row.
- **Path:** `id` = suggestion UUID.
- **Request JSON:**
  ```json
  { "reason": "str" }   // optional note
  ```
- **Response JSON (200):**
  ```json
  { "success": true, "message": "Suggestion accepted", "suggestion_id": "UUID", "status": "approved" }
  ```
- **Permission:** `can_resolve_suggestion`.
- **Errors:** `401`; `403`; `404` (suggestion); `409` if it was already accepted/rejected.

### 6. POST `/api/suggestions/{id}/reject`
- **Purpose:** reject a pending suggestion and record the reason. (No attribution row — nothing was applied.)
- **Source → target:** frontend → updates **`suggestions`** (status → `rejected`, `resolved_by`, `resolved_at`, `reason`).
- **Request JSON:** `{ "reason": "str" }` (optional).
- **Response JSON (200):** `{ "success": true, "message": "Suggestion rejected", "suggestion_id": "UUID", "status": "rejected" }`
- **Permission:** `can_resolve_suggestion`. **Errors:** `401`/`403`/`404`/`409`.

---

## 3. Comments — threaded discussion (`app/api/comments.py`)

### 7. GET `/api/documents/{id}/comments?since=`
- **Purpose:** list a document's comments (oldest first). Optionally only those created at/after a time.
- **Source → target:** frontend → reads the **`comments`** table.
- **Query (optional):** `since` = ISO datetime.
- **Response JSON (200):**
  ```json
  {
    "comments": [
      {
        "id": "UUID",
        "document_id": "UUID",
        "suggestion_id": "UUID | null",      // set if the comment is about a suggestion
        "anchor": "{ } | null",              // null = comment on the whole doc
        "author_id": "UUID",
        "body": "str",
        "parent_comment_id": "UUID | null",  // set if this is a reply
        "created_at": "datetime"
      }
    ]
  }
  ```
- **Errors:** `401`; `404` (doc).

### 8. POST `/api/documents/{id}/comments`
- **Purpose:** post a comment. Can be a top-level comment, a **reply** (set `parent_comment_id`), and/or attached to a **suggestion** (set `suggestion_id`).
- **Source → target:** frontend → writes one **`comments`** row.
- **Request JSON:**
  ```json
  {
    "body": "str",                        // required
    "anchor": { },                        // optional
    "suggestion_id": "UUID",              // optional
    "parent_comment_id": "UUID"           // optional
  }
  ```
- **Response JSON (201):** a single comment object (shape as in #7).
- **Permission:** `can_suggest`.
- **Errors:** `401`; `403`; `404` (doc); `400` if `suggestion_id`/`parent_comment_id` don't belong to this document; `422` (missing `body`).

---

## 4. Recommendations & responses — the owner's review notes (`app/api/recommendations.py`)

A "recommendation" is a note the document owner leaves on a submitted **version** (during approve/reject). The team replies to it in a **response thread**. The response thread is **append-only** — replies can never be edited or deleted (that's the accountability trail).

### 9. GET `/api/versions/{id}/recommendations`
- **Purpose:** list the owner's recommendations attached to a version (oldest first).
- **Source → target:** frontend → reads **`recommendations`**.
- **Path:** `id` = **version** UUID (versions are owned by Teammate 3's module; mine attach to them).
- **Response JSON (200):**
  ```json
  {
    "recommendations": [
      {
        "id": "UUID",
        "document_id": "UUID",
        "version_id": "UUID",
        "author_id": "UUID",
        "anchor": { },
        "body": "str",
        "status": "open | addressed | orphaned",
        "created_at": "datetime"
      }
    ]
  }
  ```
- **Errors:** `401`; `404` (version).

### 10. POST `/api/versions/{id}/recommendations`
- **Purpose:** create a recommendation on a version (accompanies an approve or a reject).
- **Source → target:** frontend → writes one **`recommendations`** row (its `document_id` is copied from the version).
- **Request JSON:**
  ```json
  { "body": "str", "anchor": { } }   // both required
  ```
- **Response JSON (201):** a single recommendation object (shape as in #9), `status` starts as `"open"`.
- **Permission:** `can_give_final_approval` (recommendations are an owner/approver action).
- **Errors:** `401`; `403`; `404` (version); `422`.

### 11. PATCH `/api/recommendations/{id}`
- **Purpose:** change a recommendation's status — e.g. mark it `addressed` once the team handled it, or `orphaned` if the text it pointed at is gone.
- **Source → target:** frontend → updates **`recommendations`** (`status`).
- **Request JSON:**
  ```json
  { "status": "open | addressed | orphaned" }   // required
  ```
- **Response JSON (200):** the updated recommendation object.
- **Permission:** `can_give_final_approval`.
- **Errors:** `401`; `403`; `404`; `422` (bad status value).

### 12. GET `/api/recommendations/{id}/responses`
- **Purpose:** read the full reply thread for a recommendation, oldest → newest.
- **Source → target:** frontend → reads **`recommendation_responses`**.
- **Response JSON (200):**
  ```json
  {
    "responses": [
      { "id": "UUID", "recommendation_id": "UUID", "author_id": "UUID", "body": "str", "created_at": "datetime" }
    ]
  }
  ```
- **Errors:** `401`; `404` (recommendation).

### 13. POST `/api/recommendations/{id}/responses`
- **Purpose:** post a reply to a recommendation (e.g. "done", "no longer applies"). **APPEND-ONLY** — there is deliberately no PATCH or DELETE for responses.
- **Source → target:** frontend → writes one **`recommendation_responses`** row.
- **Request JSON:**
  ```json
  { "body": "str" }   // required
  ```
- **Response JSON (201):** a single response object (shape as in #12).
- **Permission:** `can_suggest` (any participating team member can reply).
- **Errors:** `401`; `403`; `404`; `422`.

---

## 5. Audit — the history log (`app/api/audit.py`)

### 14. GET `/api/documents/{id}/audit?limit=&before=`
- **Purpose:** read a document's audit log (every recorded governance action), **newest first**, paginated.
- **Source → target:** frontend → reads the **`audit_log`** table. **Read-only** — this endpoint never writes.
- **Query (optional):** `limit` = 1–200 (default 50); `before` = ISO datetime (return rows older than this — used to page back through history).
- **Response JSON (200):**
  ```json
  {
    "entries": [
      {
        "id": "UUID",
        "actor_id": "UUID",
        "document_id": "UUID | null",
        "action": "str",            // e.g. "ownership_transfer", "role_change"
        "target_type": "str",       // e.g. "document", "assignment"
        "target_id": "UUID | null",
        "metadata": "{ } | null",   // free-form details of the action
        "created_at": "datetime"
      }
    ]
  }
  ```
- **Permission:** `can_view_history`.
- **Errors:** `401`; `403`; `404` (doc).

---

## 6. Ownership transfer — handover (`app/api/ownership.py`)

### 15. POST `/api/documents/{id}/transfer-ownership`
- **Purpose:** hand ownership of a document from the current owner to another user, in one safe step (e.g. a junior who created a doc hands it to their manager). "Ownership" here = an `assignments` row giving the `owner` role on that document.
- **Source → target:** frontend → reads `documents`/`users`/`roles`, then **upserts two `assignments` rows** (new owner gets `owner`, caller gets the `demote_to` role — both scoped to this document) and writes one **`audit_log`** row. All in one transaction.
- **Request JSON:**
  ```json
  {
    "to_user_id": "UUID",                                  // required: who becomes the new owner
    "demote_to": "approver | editor | suggester | viewer"  // optional, default "editor": what the caller becomes
  }
  ```
- **Response JSON (200):**
  ```json
  {
    "success": true,
    "message": "Ownership transferred to <name>",
    "document_id": "UUID",
    "new_owner_id": "UUID",
    "previous_owner_id": "UUID",
    "previous_owner_role": "owner",
    "demoted_to": "editor"
  }
  ```
- **Permission:** `can_manage_members` (only an owner has this).
- **Errors:** `400` (transferring to yourself, or target not in your org); `401`; `403`; `404` (doc); `409` (the org's `owner` role isn't configured); `422` (bad `demote_to` or `to_user_id`).
- **Why it's "safe":** it grants the new owner **before** demoting you (so the doc is never owner-less), and it works even if your ownership was inherited from a folder — the new document-scoped rows take precedence for this one document, without disturbing the folder.

---

## 7. Things you might have missed (subtle but important)

- **Reads are org-gated, not role-gated.** The four `GET` lists (suggestions, comments, recommendations, responses) only require that you're logged in and the resource is in your org — they don't check a specific permission. So anyone in the org who can reach a document can read its suggestions/comments. Tighten later if you want per-document read control.
- **Only two of my endpoints write to `audit_log`:** ownership transfer (and, in Teammate 1's code, assignment changes). Accept/reject/submit etc. do **not** write audit rows yet — that's deferred "Stage 3" work in the design. So a document's audit log will look sparse until that's wired.
- **Accept writes an `edit_attributions` row; reject does not.** Accept means a change was applied, so it records the "who changed what" event; reject applies nothing.
- **`recommendation_responses` has no `org_id` column** (by schema design). Its org-safety comes from the parent recommendation, which I resolve (and org-check) first. That's why org isolation still holds even though the row itself isn't org-tagged.
- **`version_id` belongs to Teammate 3.** My recommendation endpoints attach to a *version*, which Teammate 3's `submit-for-approval` creates. So to create a recommendation you first need a version id from `POST /api/versions/documents/{id}/submit-for-approval`.
- **Creator-owns interaction:** because creating a folder/document now makes you its `owner`, the person who creates a doc automatically passes all the permission checks above on that doc (suggest, resolve, recommend, view history, manage members). A teammate with no role on your doc gets **403** on the mutating endpoints (but **200** on the org-gated reads).
- **`anchor` is opaque to the backend.** I store and return it untouched. If the frontend sends `{}` it's accepted; the *meaning* of a valid anchor is entirely the editor's concern.
- **The AI path reuses #4.** There is no separate "AI suggestion" create endpoint of mine — the AI worker calls the same `POST /documents/{id}/suggestions` with `origin: "ai"`. (Teammate 3's `/ai/*` endpoints enqueue the job that eventually calls it.)
- **Refresh/logout are not real yet.** Don't build security assumptions on them — a "logged out" token still works until it expires, because there's no token store to revoke it.
- **All my routers mount at the bare `/api` prefix**, so the URLs above are exactly the canonical paths from the architecture doc (unlike Teammate 3's `versions`/`ai`, whose URLs repeat the module name, e.g. `/api/versions/versions/{id}`).
