# Integration Changes — Frontend ↔ Backend

**Branch:** `feature/governance-integration-fixes`
**Date:** 2026-06-16
**Scope:** Governance & Integrations cluster (versions, notifications, AI, export)

This document records the integration fixes applied and — importantly — the
frontend work that is **still outstanding** (owned by the frontend dev), so the
team has an honest picture of what does and doesn't work today.

## MSW mock layer — build/test the frontend with zero backend

While we wait on Postgres, the frontend can run against the **locked API
contract** using MSW (Mock Service Worker). MSW intercepts real `fetch` calls
and returns the exact response shapes the backend will (mirrors
`backend/app/schemas/*`).

Files:
- `frontend/src/mocks/handlers.ts` — the locked contract (auth, versions,
  notifications, ai, export). Edit here to evolve the contract.
- `frontend/src/mocks/browser.ts` — worker for dev + Playwright.
- `frontend/src/mocks/server.ts` — `setupServer` for Node/unit tests.
- `frontend/src/mocks/mock-provider.tsx` — starts the worker in the browser;
  mounted in `app/layout.tsx`.
- `frontend/public/mockServiceWorker.js` — generated worker script (`npx msw init`).

**Enable it** (off by default — zero cost in prod) via `frontend/.env.local`:
```
NEXT_PUBLIC_API_MOCKING=enabled
NEXT_PUBLIC_API_URL=http://localhost:8000/api
```
Then `npm run dev` — the whole app builds and runs against the mock contract,
no backend required. Remove the flag (or set anything else) to hit the real API.

**In tests** (Playwright/node): `import { server } from "@/mocks/server"` and
`server.listen()` / `resetHandlers()` / `close()` around your suite.

---

## 0. Latest round — CORS + real backend wiring (auth, versions)

- **CORS middleware** added to `backend/app/main.py` (+ `CORS_ORIGINS` in
  `config.py`). Browsers blocked the frontend (`http://localhost:3000`, Next.js)
  from calling the API (`:8000`) cross-origin; the middleware now sends the
  `Access-Control-Allow-*` headers and handles preflight `OPTIONS`. Override
  origins via the `CORS_ORIGINS` env var.
- **Discovered the frontend `lib/api/*` layer is a localStorage MOCK**, not real
  HTTP — confirmed by `db.ts` ("swapping these helpers for `fetch` calls is the
  only remaining integration work"). So CORS alone doesn't make the app talk to
  the backend; the mock functions must be replaced with real calls.
- **Wired to the real backend (this round):**
  - `frontend/src/lib/api/auth.ts` → `POST /api/auth/signup` & `/login`; stores
    the real JWT via `client.setToken`. (OAuth `signInWithProvider` now throws a
    clear "not available" error — backend has no OAuth.)
  - `frontend/src/lib/api/versions.ts` → `GET /documents/:id/versions`,
    `POST /documents/:id/submit-for-approval`, `POST /versions/:id/restore`.
- **Auth is the linchpin:** every other cluster needs the JWT that `auth.ts` now
  stores. With auth real, `versions` (and `notifications`/`ai`/`export`) calls
  can authenticate.
- **Still mock (owned by other clusters):** `documents.ts`, `comments.ts`,
  `collaborators.ts`. These need the same mock→`fetch` swap, plus the
  documents/data-model reconciliation noted in §4.

---

## 0b. Architecture conformance — checked vs PLATE v2

Audited the integration against the canonical architecture
(`Collaborative_Documentation_Platform_PLATE_v2.md`, §9 REST contract) and
`CHANGES_FROM_INITIAL_DESIGN.md`.

**✅ Conforms:**
| Architecture rule | Integration | OK |
|---|---|---|
| REST + JWT `Authorization: Bearer` (§4, §9) | `client.ts` sends Bearer; `auth.ts` stores the JWT from `/login`/`/signup` | ✅ |
| Canonical endpoint paths (§9.1–9.9) | routing fix mounts versions/ai/export at bare `/api`; paths match §9 | ✅ |
| CORS required before browser calls (CHANGES §12) | `CORSMiddleware` added | ✅ |
| Authority enforced server-side; client roles = UX only (Principle 4, §6) | clients never self-authorize | ✅ |
| Notifications `?unread=true` / `:id/read` / `read-all` (§9.8) | `notifications.ts` matches | ✅ |
| AI suggest / apply / poll (§9.7, async job) | `ai.ts` matches | ✅ |
| Export `?format=md\|docx` (§9.9) | `export.ts` matches | ✅ |
| Auth = email+password, JWT only, **no OAuth** (§2) | `signInWithProvider` throws "not available" — matches spec | ✅ |

**⚠️ Deviations to reconcile (both on the documents side, not the governance cluster):**
1. **Documents model is off-spec.** Architecture `documents.status` is only
   `working` / `pending_approval` (§5); the frontend `types.ts`/`documents.ts`
   invent `starred`, `trashed`, and statuses `Working/Pending Review/Approved/Draft`
   — none exist in the schema. This blocks a clean `documents.ts` → backend wiring;
   needs schema columns or a mapping layer.
2. **`restore` semantics mismatch.** Architecture (§9.5) restore is *section-level*
   ("restore a deleted section… stays pending"), but the version-history dialog
   uses it to restore a *whole snapshot*. `versions.ts` sends `section_id="full"`
   as a stopgap; reconcile with a product decision.

**🔲 Deferred by design (NOT integration gaps — per build order §13 / CHANGES §12):**
- Live editing over Hocuspocus WebSocket (`/collab/:doc_id`, §4 L2) — document
  *content* flows over WS, not REST; still unwired.
- `GET /versions/:id/approval-status` + approval-policy CRUD (§9.5a) — dynamic
  multi-step chain (build order step 5); single-gate only for now.
- AI worker (BullMQ), S3 blobs, diff engine, export serializers — backend returns
  placeholders; clients call the correct endpoints and the contracts hold.

**Verdict:** the integration is **architecturally proper for the REST governance
contract**. The only real deviations are the documents data-model and the restore
UX semantics — neither in the governance cluster.

---

## 1. Backend fix — route prefix bug (DONE ✅)

### The problem
In `backend/app/main.py`, three routers were mounted under a **sub-prefix**, but
their route decorators already carry the full resource path. This produced
**double-prefixed, wrong URLs** that did not match the architecture doc:

| Router | Old mount | Broken URL produced |
|---|---|---|
| versions | `/api/versions` | `/api/versions/documents/{id}/versions` ❌ |
| ai | `/api/ai` | `/api/ai/documents/{id}/ai/suggest` ❌ |
| export | `/api/export` | `/api/export/documents/{id}/export` ❌ |

(`notifications` was already correct because its decorators use relative paths.)

### The fix
Mount `versions`, `ai`, `export` at the **bare `/api` prefix** — the same way
Person A's collaboration routers are mounted. `notifications` is unchanged.

```python
app.include_router(versions.router, prefix=settings.API_STR, ...)
app.include_router(notifications.router, prefix=f"{settings.API_STR}/notifications", ...)
app.include_router(ai.router, prefix=settings.API_STR, ...)
app.include_router(export.router, prefix=settings.API_STR, ...)
```

Also: changed `Query(..., regex=...)` → `Query(..., pattern=...)` in
`export.py` (FastAPI deprecation).

### Verified canonical URLs (after fix)
```
GET  /api/documents/{id}/versions
GET  /api/versions/{id}
POST /api/documents/{id}/submit-for-approval
GET  /api/documents/{id}/diff?from=&to=
POST /api/versions/{id}/approve
POST /api/versions/{id}/reject
POST /api/versions/{id}/restore
POST /api/documents/{id}/ai/suggest
POST /api/recommendations/{id}/ai/apply
GET  /api/ai/jobs/{job_id}
GET  /api/notifications?unread=true
POST /api/notifications/{id}/read
POST /api/notifications/read-all
GET  /api/documents/{id}/export?format=md|docx
GET  /api/versions/{id}/export?format=md|docx
```
All confirmed by importing the app and dumping `app.routes`.

---

## 2. Frontend API clients added (DONE ✅ — my cluster only)

Added `frontend/src/lib/api/` clients for the governance cluster, each
**self-contained** (only depends on `./client`) so they compile independently
of the rest of the missing `lib` layer and don't collide with the frontend
dev's `types`/`store`/`utils`:

| File | Exports |
|---|---|
| `client.ts` | `apiFetch`, `getToken/setToken/clearToken`, `ApiError`, `API_BASE_URL` |
| `versions.ts` | `listVersions`, `getVersion`, `submitForApproval`, `getDiff`, `approveVersion`, `rejectVersion`, `restoreVersion` |
| `notifications.ts` | `listNotifications`, `markRead`, `markAllRead` |
| `ai.ts` | `suggest`, `applyToRecommendation`, `getJob` |
| `export.ts` | `exportDocument`, `exportVersion`, `downloadDocument` |

**Config needed:** create `frontend/.env.local` with
```
NEXT_PUBLIC_API_URL=http://localhost:8000/api
```
(falls back to `http://localhost:8000/api` if unset). Auth token is read from
`localStorage["docflow.token"]` and sent as a `Bearer` header.

---

## 3. Root cause found — `.gitignore` was hiding `frontend/src/lib/` (FIXED ✅)

The repo's `.gitignore` is the standard **Python** template. Line 17, `lib/`,
is meant to ignore a virtualenv's `lib/` folder — but it is **unanchored**, so
it also matched **`frontend/src/lib/`**. Git was silently refusing to track the
entire frontend `lib` layer.

This is almost certainly **why the frontend `lib/` "doesn't exist on any
branch"**: the frontend dev has the files locally (their `next dev` works), but
git never let them commit. Confirmed with `git check-ignore -v`:
```
.gitignore:17:lib/   frontend/src/lib/api/client.ts   ← ignored before
```

**Fix:** re-include the frontend source dir after the Python rule:
```gitignore
lib/
lib64/
!frontend/src/lib/
!frontend/src/lib/**
```
After the fix `git status` shows `frontend/src/lib/` as trackable. **Action for
the frontend dev:** your local `lib/` files can now be `git add`-ed and
committed — they were being ignored, not lost.

## 3b. ⚠️ Still outstanding — frontend `lib/` modules to commit

Even with tracking fixed, these `@/lib/` modules still need to be added/committed
for the app to build (`next build` fails until then). They span every
teammate's domain plus PlateJS internals, so they were **not** scaffolded here
(only my cluster's api clients were — section 2):

Missing modules still required for the app to compile:

| Module | Owner / nature |
|---|---|
| `@/lib/utils` | shadcn `cn` helper |
| `@/lib/types` | app data model (`DocSummary`, `DocVersion`, `DocFilter`, …) |
| `@/lib/data` | static UI data (`STATUS_CLASS`, …) |
| `@/lib/store/document-store` | editor state (`useDocument`) |
| `@/lib/api/auth` | auth client (sign up/in/out) |
| `@/lib/api/documents` | documents client (list/update/star/trash/…) |
| `@/lib/api/comments` | discussions (PlateJS `TDiscussion`) — Person A |
| `@/lib/api/collaborators` | sharing — collaborators cluster |
| `@/lib/api/seed` | `CURRENT_USER` placeholder |
| `@/lib/api/db` | `uid` helper |
| `@/lib/suggestion` | PlateJS suggestion plugin glue |
| `@/lib/block-discussion-index` | PlateJS discussion indexing |
| `@/lib/markdown-joiner-transform` | PlateJS markdown transform |
| `@/lib/hooks/use-presence` | live presence hook |
| `@/lib/uploadthing` | file upload integration |

These span every teammate's domain plus PlateJS-specific internals, so they were
**intentionally not scaffolded here** to avoid producing wrong code or merge
conflicts with the frontend dev's branch.

---

## 4. Known integration mismatches to resolve (follow-up)

1. **`restoreVersion` semantics:** the dialog calls
   `restoreVersion(docId, versionId)` to restore a whole snapshot, but the
   backend `POST /versions/:id/restore` is **section-scoped**
   (`RestoreRequest.section_id`). Decide whether to add a whole-version restore
   endpoint or change the UI. The client sends `section_id="full"` as a stopgap.
2. **Document data model:** the frontend `DocSummary` has `starred`, `trashed`,
   and status labels `"Working" | "Pending Review" | "Approved" | "Draft"`. The
   backend `documents` table has none of these (status is lowercase `working`,
   no star/trash columns). The documents client will need a mapping layer or the
   schema needs new columns.
3. **Author names:** version/notification responses return user **ids**, not
   display names. `versions.ts` shows the id in `authorName` until `/users` is
   wired for name resolution.

---

## Files changed in this commit

```
.gitignore                     # un-ignore frontend/src/lib (root cause of missing layer)
backend/app/main.py            # router mount fix (versions/ai/export → bare /api)
backend/app/api/export.py      # regex= → pattern=
frontend/src/lib/api/client.ts        # NEW
frontend/src/lib/api/versions.ts      # NEW
frontend/src/lib/api/notifications.ts # NEW
frontend/src/lib/api/ai.ts            # NEW
frontend/src/lib/api/export.ts        # NEW
INTEGRATION_CHANGES.md         # this file
```
