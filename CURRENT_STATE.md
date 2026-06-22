# Docolab — Current State of the Project

Single source of truth for where the codebase stands now (backend + frontend), what each part does, what changed most recently, and what still needs fixing.

---

## 1. Overview

Docolab is a collaborative documentation platform: a **Plate/Slate editor** frontend (Next.js) over a **FastAPI + async SQLAlchemy + PostgreSQL** backend, with RBAC, suggestion/comment review, versioning + **multi-step approval**, an **audit trail**, real **sessions** (refresh tokens), and an AI suggestion layer. v1 is a **single shared org** (one team/tenant); `org_id` is on every table as the multi-tenant hook.

**One line:** the backend (60 operations) is async, fully **RBAC-enforced and audited**, with a **dynamic multi-step approval chain** (now **snapshotted at submit**), an **org-admin** role, **real refresh-token sessions**, and **personal bookmarks** — validated end-to-end against Postgres (clean-state run + from-scratch migration + downgrade/upgrade reversibility). The frontend is a Plate editor on a mix of real-backend + MSW/localStorage mocks. **Live real-time collaboration (Hocuspocus/Yjs) is now BUILT and validated end-to-end against real Postgres** (see §11) — it's opt-in via env on the frontend. The remaining Tier-2 stubs are S3 cold-storage blobs, the AI worker, and content diff.

> **Status note (this branch `feature/yjs-hocuspocus-integration`):** §§1–10 below describe the v2 backend. The real-time collaboration layer (the `hocuspocus-server/` Node service + frontend Yjs wiring) was added/validated after those sections were written — see **§11 (collab changelog)** and **§12 (backend function reference)**. Where older sections say live collab is "not built / stubbed," §11 supersedes them.

---

## 2. Backend

### Stack
FastAPI · async SQLAlchemy 2.0 (asyncpg) · PostgreSQL · Pydantic v2 · JWT · passlib/bcrypt · Alembic. CORS on; `.env` loaded at startup; on startup the app **runs `alembic upgrade head` in-process** (Alembic is the single source of truth — no more `create_all`) then seeds the single org (roles + admin owner + root folder + org-admin grant).

### Database — 20 tables (+ `alembic_version`), head migration `0004`
Migration `0004_auth_stars_trash` is the v2 schema delta:

| Change | Table / column | Purpose |
|---|---|---|
| **+ table** | `refresh_tokens` | real, revocable sessions (hash-only, rotation, reuse-detection) |
| **+ table** | `document_stars` (user_id, document_id) | **personal** bookmarks (per-user) |
| **− column** | `documents.starred` (dropped) | was a *global* flag — wrong semantics; replaced by `document_stars` |
| **+ column** | `documents.trashed_at` | when a doc entered the reversible recycle bin |
| **+ column** | `versions.approval_policy_id` | **policy snapshot taken at submit** (deterministic in-flight approval) |

Earlier deltas: `0002` (documents.trashed, comments.is_resolved), `0003` (documents.yjs_state).

> **Alembic fix (why `alembic upgrade head` did nothing before):** Alembic's `alembic_version.version_num` column is `VARCHAR(32)`. Migration `0002`'s old revision id `0002_add_starred_trashed_is_resolved` was **36 chars** — Alembic applied the DDL then failed writing the version row (`value too long for type character varying(32)`), so the whole transaction **rolled back** and the DB stayed stuck at `0001` looking untouched. All revision ids are now ≤32 chars, and `create_all` (which masked migrations and caused drift) was removed in favour of in-process `alembic upgrade head` on startup.

### API surface — 60 operations (no route conflicts)
Auth (incl. **real refresh/logout**) · Users · Roles/Assignments · Folders · Documents (incl. **personal star**, trash/restore) · Suggestions · Comments (incl. resolve) · Recommendations · Versions/Approval (**policy snapshot**) · Approval Policies · Audit (per-doc + org-wide) · Ownership · AI · Export · Notifications.

New/changed this round:
- `PUT /documents/{id}/star`, `DELETE /documents/{id}/star` — **personal** bookmark add/remove (only needs read access).
- `GET /documents` — `folder_id` now **optional** (org-wide list); `?starred=true` (my bookmarks), `?trashed=true` (recycle bin).
- `POST /auth/refresh` — **real rotation** (new access + new refresh token; old one revoked; reuse → 401 + family revoke).
- `POST /auth/logout` — **real** server-side revoke of the presented refresh token.
- `POST /auth/signup` & `/login` now also return `refresh_token` (additive — existing clients ignore it).

### Cross-cutting behaviour
- **Async everywhere**; **single-org** signup; **creator-owns** on create.
- **RBAC (one choke-point):** `auth_service.resolve_role()` does the scope walk (document → folder → parents; `org` terminal); `authorize()` checks a permission; **`require_permission()`** is the single guard every mutating endpoint calls. Permissions are data in `role_permissions`.
- **Sessions:** access token = short-lived JWT (24h, unchanged). Refresh token = **opaque, random, stored only as a SHA-256 hash**. Every `/auth/refresh` **rotates** (revoke old, issue new). Reusing a rotated/revoked token revokes the user's whole token family (theft mitigation). `/auth/logout` revokes one token. Lives in `token_service.py`.
- **Personal bookmarks:** stars are per-user (`document_stars`). One person starring a doc does **not** star it for everyone, and a **viewer can bookmark a read-only doc** (star needs only `can_view_history`, not edit rights). Document responses carry a computed `starred` = "starred by me".
- **Trash vs delete (one model):** `trashed`=**reversible recycle bin** (`PATCH {"trashed": true/false}`, stamps/clears `trashed_at`); `status="deleted"` via `DELETE`=**permanent** (terminal — `GET` returns 404, hidden from every list incl. the bin). Neither is allowed while a doc is `pending_approval` (409).
- **Org-admin:** explicit **org-scoped** `assignments` row (`scope_type="org"`) with `can_manage_members`; `is_org_admin()` checks it; seeded admin has it. Not inferred from ownership.
- **Audit:** every state-changing endpoint writes an `audit_log` row in the same transaction; updates record **before→after** meta. Append-only. Readable per-document (`can_view_history`) and org-wide (`GET /audit`, org-admin). New actions: `login`, `token_refresh`, `document_trash/restore/star/unstar`.
- **Multi-step approval chain + snapshot:** at **submit**, the document's policy is **snapshotted onto the submission Version** (`versions.approval_policy_id`). The chain (and `approval-status`) resolves against that snapshot, so editing/detaching the policy mid-review can't corrupt an in-flight approval. Each step needs a **role** + `can_approve_level` + a **distinct** approver, with `min_approvals`; the baseline (`approval_markers`) advances only when the final step completes. NULL snapshot == the original single owner gate (byte-for-byte).
- **Ownership transfer:** atomic, audited handover. **Last-owner guard:** `DELETE /assignments` refuses to remove the only owner of a scope.

### What's real vs stubbed
- **Real (Postgres-backed):** auth + **real sessions** (refresh/logout), users, roles, assignments (org scope + last-owner guard), folders, documents (incl. **personal star**, trash/restore, org-filtered list), suggestions, comments (incl. resolve), recommendations, approval policies + **snapshotted** multi-step chain, version/approval bookkeeping, org-wide audit, ownership, RBAC, org-admin.
- **Stubbed (need infra):** S3 blobs + signed URLs, content diff, export serializers, AI worker (`/ai/*` placeholders), notification live-push, and the **Hocuspocus/Yjs live-collaboration + content-persistence server** (Node).

---

## 3. Frontend
Next.js 16 + React 19 + **Plate v53** (suggestions, comments, tables, media, math, AI, …). **AI via Gemini** (its own Next.js API routes), **PDF export**, docx, **MSW** mocks, Playwright. Pages: **login**, **browser**, **editor**. API clients for auth/documents/versions/comments/collaborators/ai/export/notifications. **Auth (login/signup)** and the **versions/approval** cluster call the real backend; most of the rest is localStorage/MSW (see §8).

---

## 4. What changed most recently (v2: alembic fix + auth/sessions + stars/trash + approval snapshot)
1. **Alembic fixed** — revision ids shortened to ≤32 chars (`0002`/`0003` were the blocker); `alembic upgrade head` now reaches `0004`. Startup uses in-process `alembic upgrade head` (single source of truth) instead of `create_all`.
2. **Real refresh-token store** (`refresh_tokens` + `token_service.py`) — opaque + hashed + rotation + reuse-detection; `/auth/refresh` and `/auth/logout` are no longer stubs; signup/login return a refresh token.
3. **Personal bookmarks** — dropped the global `documents.starred`; added `document_stars` + `PUT/DELETE /documents/{id}/star`; starring needs only read access; `?starred=true` lists mine.
4. **Unified trash/delete** — `trashed` = reversible bin (+`trashed_at`), `DELETE` = permanent (`GET`→404); both blocked while pending approval.
5. **Approval policy snapshot at submit** — `versions.approval_policy_id`; chain + `approval-status` resolve against the snapshot.
6. **Filtered/org-wide document list** — `GET /documents` with optional `folder_id` + `?starred`/`?trashed` (unblocks the browser's all/starred/trash views).

DB change: **+2 tables, +2 columns, −1 column** (migration `0004`). New operations: **2** (58 → 60).

---

## 5. End-to-end workflow (v1)
Sign up → join org → create folder (own it) → create docs → suggest/accept/reject + comment/resolve → (optionally attach an approval policy) → **submit (policy snapshotted)** → **chain of role-based approvals** (or single owner gate) → baseline advances → every action in the **audit log** → ownership handover. Org-admins manage members, policies, and read the org-wide audit. Personal stars + the recycle bin organize the browser. Sessions survive via refresh-token rotation. Live multi-user editing + content persistence (Yjs/Hocuspocus + S3 cold-storage snapshots) is the remaining real-time piece (see §8).

---

## 6. Validation status
Validated against the live Postgres (`docplatform`), then **left clean (empty data, schema at head `0004`)**:
- **Clean-state run:** truncated all data, restarted (re-seed), ran **all 8 suites — PASS=8**:
  `test_flow`, `test_new_endpoints`, `test_person_a_endpoints`, `test_rbac_audit`, `test_governance`, `test_auth_tokens` (rotation, reuse-detection, logout), `test_stars_trash` (personal stars, viewer-can-star, recycle bin, permanent delete, pending-approval guards), `test_approval_snapshot` (snapshot survives detach; null snapshot ignores a later-attached policy).
- **From-scratch migration:** on a throwaway DB, `alembic upgrade head` ran `0001→0002→0003→0004` clean; **downgrade to base then re-upgrade** clean (reversible).
- **No route conflicts**; app imports clean; startup auto-migrate is a no-op when already at head.

---

## 7. Known gaps & recommended fixes

### Resolved in this pass ✅
`alembic upgrade head` (revision-id overflow) + `create_all`/alembic drift; refresh-token store (refresh/logout real, rotation, reuse-detection); personal stars (global flag dropped, viewer can star); unified trash vs permanent delete (incl. `GET`→404 and pending-approval guards); approval policy snapshot at submit; org-wide/filtered document list.

### Still open
1. **Document content persistence / live collab** — the editor's Plate content is **not** persisted via REST; it lives in Yjs/Hocuspocus (+ S3 cold-storage snapshots), which is the **Node server** that isn't built. This is the cold-storage snapshot workflow: the live Y.Doc (warm) is snapshotted to cold storage when idle; submit freezes a snapshot; approval advances the baseline. **Fix:** stand up the Hocuspocus/Yjs server (canonical) — `documents.yjs_state` and version `s3_key` are the backend hooks. (A stopgap `GET/PUT /documents/{id}/content` could persist Plate JSON to a column, but would duplicate the Yjs path — not recommended.)
2. **Share links / "anyone with the link"** — frontend `collaborators.ts` models `generalAccess` + link roles; backend only has explicit `assignments`. **Fix:** a `share_links` table (token, document_id, role, expires_at) + endpoints, if link access is wanted.
3. **Role vocabulary mismatch** — frontend uses `commenter`; backend uses `suggester`. Pick one mapping when wiring the share dialog.
4. **OAuth / SSO** — login page has Google/SSO buttons that are demo-only; no backend provider. Needs an OAuth integration (and likely an `identities` table) if real.
5. **Tier-2 infra:** real S3 storage, content diff, export serializers, AI worker, notification push.
6. **Doc sprawl:** several overlapping root docs (`ARCHITECTURE.md`, `PROJECT_STATUS.md`, `INTEGRATION_CHANGES.md`, `ONBOARDING.md`, `CHANGES_FROM_INITIAL_DESIGN.md`, the API-reference docs, this file). The API-reference docs predate the canonical-mount fix and the star/trash/resolve + governance + v2 auth/stars endpoints; consolidate to avoid drift.

---

## 8. Frontend ↔ backend connection audit

What the frontend calls for real vs. what's still local-only, and how to connect it.

### Already wired to the real backend (`apiFetch`)
- **Auth:** `signIn`/`signUp` → `POST /auth/login|signup` (login also has a local `admin/admin` demo short-circuit + demo Google/SSO).
- **Versions/approval:** list / submit-for-approval / approve / reject / restore.
- **Best-effort:** document **create** fires `POST /documents` (non-blocking); `ai/*`, `export`, `notifications` use `apiFetch` (backends are stubs).

### Open-ended (localStorage/MSW only) → how to connect
| Frontend feature | Client | Backend today | How to connect | DB change |
|---|---|---|---|---|
| Browser list / rename / move | `documents.ts` (`listDocuments`, `updateDocument`) | `GET/PATCH /documents` (real) | swap localStorage for `apiFetch`; use **org-wide `GET /documents`** (`folder_id` optional) | none (added) |
| Star / bookmark | `documents.ts` `toggleStar` | `PUT/DELETE /documents/{id}/star` (real, personal) | call star endpoints; read `starred` from the doc | none (added) |
| Trash / restore / delete | `documents.ts` `setTrashed`/`deleteForever` | `PATCH {trashed}` + `?trashed=true`; `DELETE` (real) | wire to PATCH (bin) and DELETE (permanent) | none |
| **Document content** | `documents.ts` (Plate `content`) | **none in REST** (Yjs/S3) | stand up **Hocuspocus/Yjs** server (§7.1) | — |
| Comments / discussions | `comments.ts` | `POST/GET/PATCH /documents/{id}/comments` (real) | map `TDiscussion` ↔ comments; wire `getDiscussions`/`saveDiscussions` | none |
| Sharing / collaborators | `collaborators.ts` | `assignments` + `users` (real) | share dialog → `POST/GET/DELETE /assignments` + `GET /users`; reconcile role names (§7.3) | none for invites |
| General access / share link | `collaborators.ts` | none | `share_links` table + endpoints (§7.2) | new table |
| Presence (live cursors) | `collaborators.ts` `getPresence` | none | Yjs awareness (Node server) | none |
| Sessions (refresh/logout) | `auth.ts` (not wired) | **real now** | store `refresh_token`; on 401 call `POST /auth/refresh`; `signOut` → `POST /auth/logout` | none |

**Net:** the two connection blockers I removed this round were (a) no org-wide/filtered document list and (b) no personal-star endpoints — both now exist, so the browser's all/starred/trash/shared views and the editor's bookmark/trash actions can be wired with no further backend work. The remaining big one is **document content persistence (Yjs/Hocuspocus + S3)**, which is the Node real-time server, not this Python backend.

---

## 9. What actually gets logged to the backend today

Honest answer to "is editing / suggestions / versioning logged?":

- **Logged & wired (reaches Postgres from the UI today):** auth **login / signup / refresh** (sessions), and the **version lifecycle** — `submit-for-approval`, `approve`, `approve_step`, `reject`, `restore` — each writes an `audit_log` row, and the frontend `versions.ts` actually calls these. So the **approval/versioning workflow is logged**.
- **Logged if called, but NOT yet wired from the UI:** everything else the backend audits — folder/document create/update/**trash/restore/delete/star/unstar**, **suggestion create/accept/reject**, **comment create/resolve**, recommendations, role/assignment changes, ownership transfer, policy create/update/attach. The endpoints write audit rows correctly (proven by tests), but the editor/browser don't call most of them yet.
- **`edit_attributions`** (per-region "who changed what"): a row is written **only when a suggestion is accepted** (`POST /suggestions/:id/accept`). Since the frontend doesn't send suggestions yet, none are written in practice, and there is **no GET endpoint** to read this history back.
- **NOT captured at all:**
  - **Raw/live editing (Yjs):** there is no Hocuspocus/Yjs server; `documents.yjs_state` is never written; keystroke-level edits are not persisted or logged anywhere on the backend.
  - **Suggestions & comments made in the Plate editor:** the frontend keeps them in localStorage and does **not** call `POST /documents/:id/suggestions` or `/comments`, so they never reach the backend (and thus aren't logged).
  - **Document content:** never persisted to the backend (no S3 blob, no content column write). `versions.s3_key` is a pointer to nothing yet.

**So:** versioning/approval = logged. Live editing = not logged (no Yjs server). Suggestions = the backend *can* log them, but the UI doesn't send them yet, so today they aren't.

---

## 10. Remaining work / roadmap (what's left to build & connect)

### A. Backend — endpoints that exist but are STUBS (return placeholders)
| Endpoint | What's missing |
|---|---|
| `GET /versions/:id` | real S3 signed URL (returns a fake `s3://` string) |
| `GET /documents/:id/diff` | real Slate/Yjs JSON diff (returns placeholder text) |
| `/documents/:id/ai/suggest`, `/recommendations/:id/ai/apply`, `/ai/jobs/:id` | real AI worker (returns fake job ids) |
| `GET /documents/:id/export`, `GET /versions/:id/export` | real export serializers (returns mock content) |
| `GET /notifications` (+read/read-all) | stored in DB, but no live push delivery |

### B. Backend — services / endpoints NOT built yet
- **Hocuspocus/Yjs live-collaboration + content server (Node)** — the biggest piece. Persists `documents.yjs_state`, drives presence, and produces the S3 cold-storage snapshots that `versions.s3_key` should point at. Without it there is no real editing, content persistence, or live collab.
- **Real S3 storage** for submission/approved blobs (today `s3_key` points at nothing).
- **`GET` edit-attributions** — read the per-region edit history (rows get written on accept but can't be read back).
- **Search** — `GET /documents?q=` or a dedicated search endpoint (frontend search is client-side over localStorage).
- **Share links / general access** — a `share_links` table (token, document_id, role, expires_at) + endpoints, for "anyone with the link".
- **OAuth / SSO** (+ likely an `identities` table) — the login page's Google/SSO buttons are demo-only.
- **Content diff engine** (backs `GET /diff`).

### C. Frontend — wiring left (the backend already exists, just not called)
- Document browser list / rename / move → `GET/PATCH/DELETE /documents`
- Star / bookmark → `PUT/DELETE /documents/:id/star`
- Trash / restore / permanent delete → `PATCH {trashed}` / `DELETE`
- **Suggestions** (Plate plugin) → `POST /documents/:id/suggestions` + `accept`/`reject`  ← required for "suggestions logged"
- Comments / discussions → `/documents/:id/comments` (+ `resolve`)
- Sharing / collaborators → `/assignments` + `/users` (reconcile `commenter`↔`suggester`)
- Sessions → store `refresh_token`, refresh on 401, `signOut` → `POST /auth/logout`

### D. Frontend — needs the Node server first (Section B)
- Live multi-user editing, presence / cursors, and document content persistence (all Yjs/Hocuspocus).

### Priority order (suggested)
1. **Wire the existing real endpoints** from the frontend (Section C) — biggest value for zero new backend code; makes documents/stars/trash/comments/suggestions actually logged.
2. ~~Hocuspocus/Yjs~~ **DONE — see §11.** (S3 cold-storage snapshots still pending.)
3. **De-stub** AI worker, export, diff, S3 URLs (Section A).
4. **Share links, OAuth, search, edit-attribution read** as product needs dictate.

---

## 11. Real-time collaboration (Hocuspocus + Yjs) — BUILT & validated

This supersedes the "live collab not built / stubbed" notes in §§7, 8, 9, 10. The collaborative editing transport now exists as a separate **Node service** and is wired into the Plate editor. **Content** flows through Yjs/Hocuspocus and persists to `documents.yjs_state`; **governance** stays in FastAPI. The two never overlap.

### Architecture
```
Browser A ─┐                         ┌── verifyToken (shared JWT secret)
Browser B ─┼─ WebSocket ── hocuspocus-server (Node) ─┤
Browser C ─┘   (Yjs binary updates)  └── getUserRole / load / store ── PostgreSQL (documents.yjs_state)
```
- The **same JWT** the REST API issues authenticates the WebSocket (FastAPI `SECRET_KEY` must equal Hocuspocus `JWT_SECRET`).
- The Hocuspocus **room name = the real document UUID**; `getUserRole` mirrors the backend's `resolve_role` scope walk (document → folder → parents) so RBAC is identical on both sides. `viewer` ⇒ read-only connection.
- v1 persistence = **full-state snapshot**: the whole Y.Doc is encoded to the `documents.yjs_state` BYTEA column, debounced (2s / max 10s).

### `hocuspocus-server/` (Node, ESM, Hocuspocus v3 — matches `@hocuspocus/provider` v3 on the frontend)
| File | Exports / contents | Notes |
|---|---|---|
| `server.js` | `buildServer({ port, quiet }) → Server` | Hooks: `onAuthenticate` (verify JWT → resolve role → set `connectionConfig.readOnly`, return `{user, role}` as context), `onLoadDocument` (apply stored state), `onStoreDocument` (encode + persist), `onConnect`/`onDisconnect` (log). Auto-listens only when run directly (`node server.js`); importable for tests. |
| `auth.js` | `verifyToken(token) → {id}\|null`, `getUserRole(userId, documentId) → roleName` | JWT is HS256 with only `sub` (no org_id/email). `getUserRole` walks document → folder → parent folders by `(user_id, scope_type, scope_id)`, default `"viewer"`. |
| `db.js` | `query(sql, params) → result`, `setPool(pool)`, `getPool()` | Lazy `pg.Pool` from `DATABASE_URL`; `setPool` lets tests inject `pg-mem`. |
| `storage.js` | `loadDocument(docId) → Uint8Array\|null`, `storeDocument(docId, state) → void` | `SELECT/UPDATE documents.yjs_state`; converts Buffer ↔ Uint8Array. |
| `test.js` | pure unit tests (JWT, role-resolution shape, byte conversion, read-only set) | `node --test` |
| `test/schema.mjs` | `createTestDb() → {db, pool}`, `ids` | In-memory Postgres (`pg-mem`) with a faithful subset of the real schema + seed graph. |
| `test/auth-db.test.mjs` · `storage-db.test.mjs` · `e2e-db.test.mjs` | real `auth.js`/`storage.js`/`server.js` against `pg-mem` | RBAC hierarchy, storage round-trip, full provider↔server↔DB e2e. |
| `.env` (gitignored) | `COLLAB_PORT=1234`, `DATABASE_URL=postgresql://postgres:root@localhost:5432/docplatform`, `JWT_SECRET=your-secret-key-same-as-fastapi` | `JWT_SECRET` **must match** backend `SECRET_KEY`. |

### Frontend wiring
- `src/components/editor/plugins/yjs-kit.tsx` — `createYjsPlugin(docId, token)` configures Plate's `YjsPlugin` with a Hocuspocus provider (`NEXT_PUBLIC_COLLAB_URL`).
- `src/components/editor/plate-editor.tsx` — **collab is opt-in** via `NEXT_PUBLIC_COLLAB_ENABLED === "true"`. When **off** (default) the editor seeds from REST `content` and autosaves locally (works with no server). When **on**, it skips Plate's seeding, adds the Yjs plugin, and runs the required `yjs.init({ id: routeDocId, value: doc.content, autoConnect })` + `destroy()` lifecycle. The Yjs **room = the route docId (real UUID)**, not the local mock record id.
- Env: `frontend/.env.local` has `NEXT_PUBLIC_COLLAB_URL=ws://localhost:1234`. **To turn collab on, add `NEXT_PUBLIC_COLLAB_ENABLED=true`** (currently absent ⇒ off).

### Backend touchpoints (already in the FastAPI side)
- `documents.yjs_state BYTEA NULL` (migration `0003`) — the collab server reads/writes this. NULL = fresh doc.
- `documents.yjs_doc_key` — original schema bridge field; the collab layer currently keys rooms by document **id** (yjs_doc_key is set = str(doc_id) on create, so they coincide).
- `requirements.txt` pins **`bcrypt==4.0.1`** — `passlib 1.7.4` can't read `bcrypt>=4.1` / errors on bcrypt 5; without the pin FastAPI startup crashes.

### Validation done (real stack, against live Postgres `docplatform`)
- **54 automated tests** pass (`cd hocuspocus-server && npm test`): unit + `pg-mem`-backed RBAC, storage, and full e2e (provider ↔ server ↔ DB).
- **Live real-stack check:** started FastAPI + Hocuspocus + Postgres, seeded a real document + two users (owner/editor) via `scripts/seed-collab-test.mjs`, connected two real provider clients with **real FastAPI JWTs** → both authenticated (`role=owner`/`role=editor`, `readOnly=false`), **bidirectional live sync**, invalid token rejected, and **content persisted to Postgres and reloaded intact** (real PG preserves the binary `yjs_state`; note `pg-mem` mangles bytes ≥128, so binary fidelity is asserted at the Buffer↔Uint8Array layer there).

### How to run the real browser test
1. Backend `.env`: `DATABASE_URL=postgresql+asyncpg://postgres:root@localhost:5432/docplatform`, `SECRET_KEY=your-secret-key-same-as-fastapi`.
2. `cd backend && python -m uvicorn app.main:app --port 8000` (startup migrates + seeds roles).
3. `cd hocuspocus-server && npm start`.
4. `node scripts/seed-collab-test.mjs` → prints a real doc UUID + two JWTs + the editor URL.
5. `frontend/.env.local`: add `NEXT_PUBLIC_COLLAB_ENABLED=true`; `cd frontend && npm run dev`.
6. Open `http://localhost:3000/editor?doc=<UUID>` in two windows, set `localStorage.docflow.token` to each JWT (or log in as `alice@example.com` / `bob@example.com`, password `password123`), type → live sync.

### Still pending for collab
- **S3 cold-storage snapshots** (`versions.s3_key` still points at nothing) — the submit/approve freeze workflow.
- **Presence/cursors** UI from Yjs awareness (transport exists; `collaborators.ts getPresence` still mock).
- **Frontend metadata layer** (`documents.ts`) is still localStorage/MSW — so titles/list are mock while *content* is real-collab. Wiring `documents.ts` to the real API is the separate "replace demo APIs" effort.

---

## 12. Backend function reference (paste-ready, `backend/` only)

Brief signatures so another chat has full context. Format: `METHOD path → handler(meaningful params) → ResponseModel`. DB/session/current-user injections (`Depends`) are omitted. Base prefix = `/api`.

### Entrypoint & core
- `app/main.py` — builds `FastAPI` app, CORS, includes all routers (prefixes below), `@app.on_event("startup")`: runs in-process `alembic upgrade head` then seeds org (roles + permissions + admin owner + root folder + org-admin grant).
- `app/core/config.py` — `Settings` (env: `DATABASE_URL`, `SECRET_KEY`, `ALGORITHM=HS256`, `ACCESS_TOKEN_EXPIRE_MINUTES=1440`, `DEFAULT_ORG_ID`, `CORS_ORIGINS`); `settings` singleton.
- `app/core/database.py` — `engine` (async), `AsyncSessionLocal`, `Base(DeclarativeBase)`, `async get_db() → AsyncSession`.
- `app/core/security.py` — `verify_password(plain, hashed) → bool`; `get_password_hash(password) → str`; `create_access_token(subject, expires_delta=None) → str` (JWT `{sub, exp}`).
- `app/api/deps.py` — `async get_current_user(token, db) → User` (decodes JWT, loads user, 401 on failure).

### Services
- `auth_service.py`
  - `async resolve_role(db, user_id, scope_type, scope_id) → (Role|None, role_name|None, via_scope|None)` — scope walk: document → folder → parents → org.
  - `async authorize(db, user_id, permission, scope_type, scope_id) → (bool, role_name|None, via_scope|None)`.
  - `async require_permission(db, user_id, permission, scope_type, scope_id, ...)` — single guard; raises 403 if denied.
  - `async is_org_admin(db, user) → bool` — checks org-scoped `can_manage_members`.
- `token_service.py`
  - `hash_token(raw) → str` (SHA-256); `issue_refresh_token(db, user) → str` (raw, stores hash);
  - `async rotate_refresh_token(db, raw) → (User, new_raw)` (revokes old; reuse → revoke family + raise);
  - `async revoke_refresh_token(db, raw) → bool`.
- `audit_service.py` — `record_audit(db, *, org_id, actor_id, action, document_id=None, target_type=None, target_id=None, meta=None) → AuditLog` (append-only, same txn).

### Models (`app/models/database_models.py`, 20 tables, all `Base`)
`User`·users, `Role`·roles, `RolePermission`·role_permissions, `Assignment`·assignments, `Folder`·folders, `Document`·documents, `DocumentStar`·document_stars, `Suggestion`·suggestions, `Comment`·comments, `EditAttribution`·edit_attributions, `Notification`·notifications, `Version`·versions, `ApprovalPolicy`·approval_policies, `ApprovalMarker`·approval_markers, `ApprovalPolicyStep`·approval_policy_steps, `ApprovalStepEvent`·approval_step_events, `Recommendation`·recommendations, `RecommendationResponse`·recommendation_responses, `AuditLog`·audit_log, `RefreshToken`·refresh_tokens. (`Document` carries `yjs_doc_key`, `yjs_state`, `trashed`, `trashed_at`, `status`, `current_version_no`.)

### API routers (METHOD path → handler → ResponseModel)
**Auth** `/api/auth` — `POST /signup(UserCreate) → Token`; `POST /login(LoginRequest) → Token`; `GET /me → UserResponse`; `POST /refresh(RefreshRequest) → RefreshResponse`; `POST /logout(LogoutRequest) → LogoutResponse`.

**Roles** `/api/roles` — `GET "" → RoleListResponse`.

**Users** `/api/users` — `GET "" → UserListResponse`; `GET /{id} → UserResponse`; `PATCH /{id}(UserUpdate) → UserResponse`.

**Folders** `/api/folders` — `POST ""(FolderCreate) → FolderResponse`; `GET "" → FolderListResponse`; `GET /{id} → FolderResponse`; `PATCH /{id}(FolderUpdate) → FolderResponse`; `DELETE /{id} → 204`.

**Documents** `/api/documents` — `POST ""(DocumentCreate) → DocumentResponse`; `GET ""(folder_id?, starred?, trashed?) → DocumentListResponse`; `GET /{id} → DocumentResponse`; `PATCH /{id}(DocumentUpdate) → DocumentResponse`; `DELETE /{id} → 204` (permanent); `PUT /{id}/star → StarResponse`; `DELETE /{id}/star → StarResponse`; `GET /{id}/authorize-check(permission) → AuthorizeCheckResponse`.

**Assignments** `/api/assignments` — `POST ""(AssignmentCreate) → AssignmentResponse`; `GET ""(scope_type, scope_id) → AssignmentListResponse`; `DELETE /{id} → 204` (last-owner guard).

**Suggestions** `/api` — `GET /documents/{id}/suggestions → SuggestionListResponse`; `POST /documents/{id}/suggestions(SuggestionCreate) → SuggestionOut`; `POST /suggestions/{id}/accept → SuggestionResolveResponse` (writes `edit_attributions`); `POST /suggestions/{id}/reject → SuggestionResolveResponse`.

**Comments** `/api` — `GET /documents/{id}/comments → CommentListResponse`; `POST /documents/{id}/comments(CommentCreate) → CommentOut`; `PATCH /comments/{id}/resolve(CommentResolve) → CommentOut`.

**Recommendations** `/api` — `GET /versions/{id}/recommendations → RecommendationListResponse`; `POST /versions/{id}/recommendations(RecommendationCreate) → RecommendationOut`; `PATCH /recommendations/{id}(RecommendationUpdate) → RecommendationOut`; `GET /recommendations/{id}/responses → RecommendationResponseListResponse`; `POST /recommendations/{id}/responses(RecommendationResponseCreate) → RecommendationResponseOut`.

**Versioning & Approval** `/api` — `GET /documents/{id}/versions → VersionListResponse`; `GET /versions/{id} → VersionMetadataResponse` (S3 URL stub); `POST /documents/{id}/submit-for-approval(SubmitForApprovalRequest) → SubmitForApprovalResponse` (snapshots policy onto version); `GET /documents/{id}/diff → DiffResponse` (stub); `POST /versions/{id}/approve(ApprovalRequest) → ApprovalResponse` (multi-step chain); `POST /versions/{id}/reject(RejectRequest) → RejectResponse`; `POST /versions/{id}/restore(RestoreRequest) → RestoreResponse`.

**Approval Policies** `/api` — `GET /approval-policies → ApprovalPolicyListResponse`; `POST /approval-policies(ApprovalPolicyCreate) → ApprovalPolicyOut`; `PATCH /approval-policies/{id}(ApprovalPolicyUpdate) → ApprovalPolicyOut`; `PATCH /documents/{id}/approval-policy(AttachPolicyRequest) → AttachPolicyResponse`; `GET /versions/{id}/approval-status → ApprovalStatusResponse` (resolves against snapshot).

**Ownership** `/api` — `POST /documents/{id}/transfer-ownership(TransferOwnershipRequest) → TransferOwnershipResponse` (atomic, audited).

**Audit** `/api` — `GET /documents/{id}/audit → AuditListResponse` (needs `can_view_history`); `GET /audit → AuditListResponse` (org-admin, org-wide).

**Notifications** `/api/notifications` — `GET "" → NotificationListResponse`; `POST /{id}/read → MarkNotificationReadResponse`; `POST /read-all → MarkAllNotificationsReadResponse`.

**AI (stub)** `/api` — `POST /documents/{id}/ai/suggest(AISuggestRequest) → AISuggestResponse`; `POST /recommendations/{id}/ai/apply(ApplyAIRecommendationRequest) → ApplyAIRecommendationResponse`; `GET /ai/jobs/{job_id} → AIJobStatusResponse`.

**Export (stub)** `/api` — `GET /documents/{id}/export → ExportResponse`; `GET /versions/{id}/export → ExportResponse`.

### Schemas (`app/schemas/*.py`, Pydantic v2)
`auth`: UserCreate/Update/Response, UserListItem/Response, Token, LoginRequest, Refresh/Logout Request/Response. `document`: DocumentCreate/Update/Response, DocumentListItem/Response, AuthorizeCheckResponse, StarResponse. `folder`: FolderCreate/Update/Response, FolderTreeItem, FolderListResponse. `assignment`: AssignmentCreate/Response, AssignmentListEntry/Response. `suggestion`: SuggestionCreate, SuggestionResolveRequest, SuggestionOut, SuggestionList/ResolveResponse. `comment`: CommentCreate, CommentOut, CommentResolve, CommentListResponse. `recommendation`: RecommendationCreate/Update, RecommendationResponseCreate, RecommendationOut/ListResponse, RecommendationResponseOut/ListResponse. `version`: VersionResponse/ListResponse, VersionMetadataResponse, DiffResponse, SubmitForApproval/Approval/Reject/Restore Request/Response. `approval_policy`: ApprovalPolicyStepIn/Out, ApprovalPolicyCreate/Update/Out/ListResponse, AttachPolicyRequest/Response, ApprovalStepStatus, ApprovalStatusResponse. `audit`: AuditEntryOut, AuditListResponse. `ownership`: TransferOwnershipRequest/Response. `notification`: NotificationResponse/ListResponse, MarkNotificationRead Request/Response, MarkAllNotificationsReadResponse. `role`: RoleResponse/ListResponse. `ai`: AISuggestRequest/Response, ApplyAIRecommendationRequest/Response, AIJob/StatusResponse. `export`: ExportResponse.

---

## 13. Most recent changes (branch `feature/yjs-hocuspocus-integration`)

**Backend**
- `requirements.txt` — pinned `bcrypt==4.0.1` (passlib 1.7.4 incompatible with bcrypt ≥4.1/5; fixes a startup crash).
- (`documents.yjs_state` BYTEA from `0003` is now actually consumed by the collab server — previously dormant.)

**Frontend**
- `plate-editor.tsx` — Yjs room now uses the canonical **route docId** (real UUID) instead of the mock record id; collab gated behind `NEXT_PUBLIC_COLLAB_ENABLED`.
- `yjs-kit.tsx`, env wiring (`NEXT_PUBLIC_COLLAB_URL`).

**New Node service** — entire `hocuspocus-server/` (see §11) + `test/` suite (54 tests).

**Tooling** — `scripts/seed-collab-test.mjs` (provisions a real doc + 2 users via the live API and prints a ready-to-use editor URL + JWTs).

**Local config (gitignored, not committed):** `backend/.env`, `frontend/.env.local`, `hocuspocus-server/.env`.

CHANGES ON 22/6
### Document Creation Logic Update
- **Refactor:** `create_document` now supports root-level document creation (no folder required).
- **Changes:**
  - Modified `Document` model to allow `folder_id` to be `Optional` (nullable).
  - Updated `create_document` route to conditionally validate `folder_id`.
  - Added organization-level permission check for root documents (`"organization"` scope).
- **Previous Behavior:** Documents were strictly required to be inside a folder, causing `400 Bad Request` or `403 Forbidden` errors if no `folder_id` was provided or if the user lacked specific folder-level assignments.
- **New Behavior:** System now supports both folder-scoped documents and root-level documents (scoped to the user's organization).