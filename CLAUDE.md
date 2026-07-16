# Docolab — Project Instructions

## NEW (2026-07-16, later): Ask-AI merged INTO the backend

The standalone `ask-ai-service/` is **deleted**. Its LLM router now lives in the
backend at **`backend/app/services/ask_ai/`** (same LiteLLM code, same
`config.yaml`, moved with `git mv` so history follows), exposed as two routes on
the normal backend API. There is no second service, no second deploy, and no
`ASK_AI_URL` / `ASK_AI_SERVICE_TOKEN` anywhere. `render.yaml` (which only ever
deployed the Ask-AI service) is deleted too.

**Why**: the admin's per-user model assignment was dead on the Ask-AI path. Two
disjoint namespaces existed — the admin catalog held `google:gemini-2.5-flash`,
`openai:gpt-4o` (models nothing could call) while the router knew
`groq:llama_70b`, `gemini:gemini_flash`, … and the editor sent whatever the user
picked in **localStorage**. `users.ai_model` was written by the admin and read by
nobody. Merging put `current_user` in scope, which makes both model governance
and usage metering local reads/writes instead of needing grants/service tokens.

- **Endpoints** (both need the user's normal bearer token):
  `POST /api/ai/ask` `{query, context, session_id, document_id}` and
  `GET /api/ai/models` (the caller's assigned model + the enabled catalog).
  There is deliberately **no `model` field on the request** — the backend
  resolves `users.ai_model` against the org's ENABLED catalog (falling back to
  the org default), so a client cannot pick an ungoverned model. Errors: 409
  unknown/disabled model or missing provider key, 422 context window (after one
  summarize-retry), 429 rate limit, 502 provider failure.
- **One namespace**: `ai_models.model_key` IS the router's `provider:model_key`
  id. The catalog is DERIVED from `config.yaml` (`ai_model_service.seed_catalog`)
  and reconciled into every org on startup, so anything an admin can assign is by
  construction callable. `config.yaml` decides what EXISTS; `ai_models` decides
  per-org what is ENABLED + the default. Migration `0012_ask_ai_catalog` deletes
  the old uncallable rows and clears stale `users.ai_model` values (empty = use
  the org default). Adding a model to `config.yaml` is an operator action.
- **Model picker REMOVED** from the editor (`ai-menu.tsx` now shows the assigned
  model read-only; `docolab.ai-model` localStorage and `AI_MODEL_STORAGE_KEY`
  are gone). Choosing a model is an admin action: Admin > Users > AI Model.
- **Telemetry now works**: `ai_usage_events` had a schema + admin aggregations +
  fully-wired `analytics-cards.tsx`, but NOTHING wrote to it (the writer was the
  retired ai-gateway). `POST /ai/ask` now writes a row per successful call using
  the vendor's real `usage` (input+output tokens); attribution comes from the
  session and the backend's own resolution, never the client. `document_id` is
  the one client field and is validated against the caller's org. Failed calls
  are not metered. `LLMProvider.generate` returns `{text, input_tokens,
  output_tokens}` (was a bare string) and the pipeline prefers vendor counts over
  its own estimate.
- **Keys**: `GROQ_API_KEY` / `GEMINI_API_KEY` / `NVIDIA_API_KEY` now live ONLY in
  `backend/.env` (were `ask-ai-service/.env`). `config.yaml` references them as
  `${VAR}`. An unset `${VAR}` expands to the literal placeholder (truthy!), which
  used to get sent upstream as a real key and returned the vendor's opaque "API
  key not valid" — `ModelRegistry.get_api_key` now detects that and raises
  `MissingApiKeyError` → 409 to the user, `Set GEMINI_API_KEY in backend/.env` to
  the server log only.
- **Deps**: `litellm>=1.40.0,<1.92.0` + `groq` + `pyyaml` added to
  `backend/requirements.txt`. The 1.92 cap is deliberate: it ships no Python 3.13
  wheel, so pip builds from source and fails without a Rust toolchain.
- **Tests**: `backend/test_ask_ai.py` (15 offline unit tests, vendor mocked) and
  `backend/test_ai_usage_metering.py` (5 live-DB integration tests: real routes +
  DB + admin aggregations, vendor mocked). Both pass. The old suite's HTTP tests
  (`/health`, the service-token gate) went with the deleted service.

### Superseded: the standalone Ask-AI service (2026-07-16, earlier)

Kept for context — **all of the below is obsolete**; the service described here
no longer exists.

- **Endpoints**: `GET /health` (default + available models) and `POST /ask`
  `{query, context, model, session_id}` — query = what the user typed or the
  clicked Ask-AI action (fix grammar, make longer, ...), context = the
  selected document section, model = `provider:model_key` (empty → default),
  session_id = per-user multi-turn memory (in-memory, 1h TTL). Errors: 400
  unknown model, 422 context window (after one summarize-retry), 429 rate
  limit, 502 provider failure.
- **Frontend**: `app/api/ai/command/route.ts` rewritten — translates the Plate
  editor request into `/ask` and converts the JSON answer back into the AI-SDK
  UI-message stream, so streaming insert, suggestion diffs, and the existing
  **Accept / Reject** menu work unchanged. `use-chat.ts` fake-stream mock
  removed (errors now surface as toasts); sends `sessionId` (user id) +
  `model`. New `app/api/ai/models/route.ts` proxies `/health`; `ai-menu.tsx`
  gained a model picker (persisted in localStorage `docolab.ai-model`).
- **Env**: `frontend/.env.local` → `ASK_AI_URL=http://localhost:8001`
  (server-side only). Provider keys live ONLY in `ask-ai-service/.env`
  (`GROQ_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`).
- **Unchanged**: `ai-gateway/`, backend `api/ai.py` grant/usage endpoints, the
  admin model catalog, and the (unmounted) copilot route still exist and
  function — they are just no longer on the editor's Ask-AI path.
- **Tests**: `ask-ai-service/test_ask_ai_service.py` (offline, provider
  mocked, 14 tests). Route integration verified against a stub + the live
  service; `tsc` + `eslint` clean on all touched frontend files.
- **Hosted deploy (Render + Vercel)**: repo-root `render.yaml` deploys the
  service to Render (`rootDir: ask-ai-service`, start `python run.py`, health
  `/health`; `run.py` binds `0.0.0.0:$PORT` and is cwd-independent). Vercel
  needs env vars `ASK_AI_URL=https://<render-service>.onrender.com` and
  (recommended) `ASK_AI_SERVICE_TOKEN` matching the same var on Render —
  when set on both sides `POST /ask` requires `Authorization: Bearer <token>`
  (unset = open, exact local-dev behavior; `/health` always open). The
  command route sets `maxDuration = 60` so LLM calls survive Vercel's
  serverless timeout. Full steps: `ask-ai-service/README.md` → Deploy.

## RESOLVED (2026-07-03): follow-up fixes + new features

Second pass after the 2026-07-02 production fixes. All backend-verifiable via
`backend/` regression scripts run against the live stack; all UI paths
verified live in-browser (console clean, zero errors).

**Bug found & fixed: `yjs.destroy()` console error.** The 2026-07-02
StrictMode guard skipped re-running `init()` on the phantom remount but still
unconditionally called `destroy()` on cleanup — including the FIRST (phantom)
cleanup, before `init()` had reached `YjsEditor.connect()` (which registers
the Y.Doc observer). Yjs's `unobserveDeep` then logged "[yjs] Tried to remove
event handler that doesn't exist" on every mount. Fixed by deferring
`destroy()` by one macrotask (`setTimeout(...,0)`) so a synchronous StrictMode
remount cancels it before it fires; in production (no double-invoke) this is
just a normal single init/destroy pair. `plate-editor.tsx`.

**Storage tiering reworked** to match: cold = approved versions (permanent),
warm = pending-submission versions (permanent until decided), idle = a single
mutable "last known state" snapshot that's OVERWRITTEN (never appended).
- Removed the manual "Save version" feature entirely (`POST
  /documents/{id}/versions`, `SnapshotCreateRequest`, the button in
  `version-history-dialog.tsx`) — it let users create unlimited permanent
  version rows, defeating the point of tiering.
- Added `documents.content_snapshot` JSONB (migration `0007_content_snapshot`)
  — one column, always overwritten. New `PUT /documents/{id}/snapshot`.
  Written by Ctrl+S / File > Save (`plate-editor.tsx`, `doc-menubar.tsx`) and
  on leaving the document (piggybacked on the same deferred-destroy timer
  above, so it only fires once on a REAL unmount).
- The HOT tier (`documents.yjs_state`, Hocuspocus's own debounced persist) was
  already correct and needed no change — verified it keeps overwriting the
  same row on every edit burst regardless of who's connected.

**Notification bug found & fixed:** `submission_pending` was notifying the
SUBMITTER (`user_id=current_user.id`) instead of the approver — the person
who needed to act never heard about it. New `app/services/
notification_service.py` centralizes recipient resolution (direct
document-scope assignees only, not the full org/folder inheritance walk —
this is best-effort UX, not a security boundary) and adds two new types:
`version_approved`/`version_rejected` (submitter + doc participants, not the
decider) and `recommendation_created` (submitter, when a Manager leaves
feedback). Wired into `versions.py::_mint_baseline`/`reject_version` and
`recommendations.py::create_recommendation`.

**Notification bell rebuilt** (`components/notification-bell.tsx`) from a
toast-only stub into a real dropdown: unread badge, mark-read/mark-all-read,
click-to-navigate deep links (`/editor?doc=X&open=versions|compare|
recommendations[&compareVersion=Y]`), consumed once on mount by
`editor-top-bar.tsx` then stripped from the URL. Mounted in both `top-nav.tsx`
(browser page) and `editor-top-bar.tsx` (editor) so a notification is
reachable from wherever the user currently is.

**New `RecommendationsPanel`** (`components/editor/recommendations-panel.tsx`)
— a dedicated side panel (same pattern as CommentsPanel) listing every
Manager recommendation across the doc's version history with reply threads
and a "Mark addressed" action (gated on `caps.canApprove`). Toggled via a new
icon in the editor top bar and via notification deep-links.

**Live-update polling added** (comments were REST-backed, not part of the Yjs
doc, so another user's comment/resolve/edit never appeared without a reload):
- `discussion-sync.tsx` polls every 5s while the Comments panel is open,
  merging (not replacing) so an in-flight local write can't be wiped by a
  poll landing mid-request, and a genuine remote deletion isn't resurrected
  by treating "was previously synced, now missing from backend" differently
  from "never synced yet, still uploading."
- `browser/page.tsx` polls the doc list every 15s + refetches on window
  focus — fixes "a newly-shared doc doesn't show up for the recipient" (this
  was NEVER a backend bug — verified via a live 2-user API test that sharing
  is reflected server-side instantly; the list was just stale client-side).
- `access-control-panel.tsx::changeRole/revoke` made optimistic (update local
  state immediately, roll back on failure) instead of waiting on the
  revoke+assign round-trip, addressing "role change feels slow to reflect."

**Dead code removed**: `components/editor/access-control-panel.tsx` — never
imported by anything (confirmed via full-repo grep both before and after this
change), duplicate of `ShareDialog`'s functionality.

**Fixed**: signup page (`app/page.tsx`) branding column was invisible/garbled
— `max-w-md` resolves to `12px` in this project's Tailwind v4 config (already
documented below), squishing the whole left panel into a vertical sliver.
Replaced with an explicit `max-w-[420px]`, matching the login page's pattern.
Also caught a second leftover "Docflow" on `login/page.tsx`'s desktop panel
(the earlier `replace_all` missed it — different surrounding whitespace).

**Known pre-existing, out-of-scope lint debt**: `npm run lint` reports ~36
errors, all inside vendored/generated Plate.js template files under
`components/ui/*-node.tsx` (`suggestion-node.tsx`, `table-node.tsx`,
`block-draggable.tsx`, etc.) — none touched this session or last. `next
build` (what actually gates a Vercel deploy) is unaffected and passes clean;
confirmed repeatedly throughout both sessions.


## Architecture: 3-Service Monorepo

| Service | Dir | Runtime |
|---------|-----|---------|
| Frontend | `frontend/` | Next.js 16 / React 19 / TypeScript |
| Backend | `backend/` | FastAPI / SQLAlchemy async / PostgreSQL (incl. the Ask-AI LLM router, `app/services/ask_ai/`) |
| Collab WS | `hocuspocus-server/` | Node.js / Hocuspocus / Y.js |

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Language (FE) | TypeScript 5 | strict mode |
| Framework | Next.js 16.2.9 (App Router) | React 19 |
| Editor | Plate.js v53 | `@platejs/*` packages |
| Styling | Tailwind CSS v4 + shadcn/ui | `components.json` driven |
| AI | `backend/app/services/ask_ai/` (LiteLLM) | `POST /api/ai/ask`; called by `src/app/api/ai/command/route.ts` |
| State | React context (`lib/store/document-store.tsx`) | no redux/zustand |
| Language (BE) | Python 3.11+ | |
| Framework (BE) | FastAPI + Pydantic v2 | async throughout |
| ORM | SQLAlchemy 2.0 async + asyncpg | |
| Migrations | Alembic | `alembic upgrade head` — never `create_all` |
| Auth (BE) | JWT (PyJWT) + argon2-cffi | access + refresh token rotation |
| Collab | Hocuspocus 3 + Y.js | JWT-validated WebSocket |
| Testing (FE) | msw 2 + Playwright | mocks in `src/mocks/` |
| Testing (BE) | httpx scripts (`test_*.py` in `backend/`) | no pytest runner configured |

## Running the Stack

```bash
# Frontend
cd frontend && npm run dev          # http://localhost:3000

# Backend
cd backend && python run.py         # http://localhost:8000
                                    # auto-migrates on startup (AUTO_MIGRATE=1)

# Collaboration server
cd hocuspocus-server && npm run dev # WebSocket default port

# (Ask-AI has no server of its own — it runs inside the backend above.)
```

## Environment Variables

**frontend/.env.local**
```
NEXT_PUBLIC_API_URL=http://localhost:8000/api  # defaults to this if unset
```
(No AI vars: the AI routes proxy to NEXT_PUBLIC_API_URL like everything else.)

**backend/.env** (copy from `.env.example`)
```
DATABASE_URL=postgresql+asyncpg://...
SECRET_KEY=<long random string>   # must match hocuspocus-server JWT_SECRET
ACCESS_TOKEN_EXPIRE_MINUTES=60
REFRESH_TOKEN_EXPIRE_DAYS=30
GROQ_API_KEY=...     # AI provider keys live ONLY here. Without a key the
GEMINI_API_KEY=...   # matching provider's models return 409 ("not configured
NVIDIA_API_KEY=...   # on this server") — never a vendor auth error.
```

**hocuspocus-server/.env** (copy from `.env.example`)
```
JWT_SECRET=<same as backend SECRET_KEY>
```

## Key Entry Points

- **Frontend pages**: `frontend/src/app/{login,browser,editor}/page.tsx`
- **Next.js API routes (AI)**: `frontend/src/app/api/ai/{command,copilot}/route.ts`
- **API client**: `frontend/src/lib/api/client.ts` — all backend calls go through `apiFetch()`
- **Backend entry**: `backend/app/main.py` — router registration + startup seed
- **Backend routers**: `backend/app/api/` — one file per domain
- **DB models**: `backend/app/models/database_models.py`
- **Collab server**: `hocuspocus-server/server.js`

## Frontend Directory Map

```
src/app/          → Next.js App Router pages + Next.js API routes
src/components/   → React components
  editor/         → Plate.js editor + plugins
  ui/             → shadcn/ui primitives
src/hooks/        → generic React hooks
src/lib/
  api/            → typed wrappers for every backend endpoint
  store/          → document-store context
  hooks/          → feature hooks (presence, etc.)
src/mocks/        → msw browser/server/handlers
```

## Backend Directory Map

```
app/api/          → FastAPI routers (one per domain)
app/core/         → config, database session, security helpers
app/models/       → SQLAlchemy ORM models
app/schemas/      → Pydantic request/response schemas
app/services/     → business logic layer
alembic/          → migration scripts
```

## RBAC

UI roles → backend roles:

| UI | Backend | Key permissions |
|----|---------|-----------------|
| Owner | `owner` | everything incl. `can_manage_members`, `can_manage_approval_policy` |
| Manager | `approver` | edit + approve + resolve suggestions |
| Collaborator | `editor` | edit + suggest + submit for approval |
| Viewer | `viewer` | `can_view_history` only |

Seeded at startup in `app/main.py::ROLE_PERMISSIONS`. Authorization checked via `app/core/authorize-check`.

## Request Lifecycle (Frontend → Backend)

1. Component calls `apiFetch<T>(path)` from `lib/api/client.ts`
2. Bearer token read from `localStorage.docflow.token`; auto-refreshes on 401
3. FastAPI validates JWT → resolves user + role assignments
4. SQLAlchemy ORM query → asyncpg → PostgreSQL
5. For live collab: `@hocuspocus/provider` WebSocket → `hocuspocus-server` → JWT validated → Y.js CRDT synced to PostgreSQL

## Code Conventions

- **File names**: kebab-case (`document-store.tsx`, `use-presence.ts`)
- **Components**: PascalCase
- **API modules**: `src/lib/api/<domain>.ts` — one per backend router
- **Error handling**: `ApiError` class from `lib/api/client.ts`; backend raises `HTTPException`
- **Migrations**: always add Alembic migrations for schema changes — never use `Base.metadata.create_all`
- **Plate.js gotcha**: shared-node references need `dynamic()` cast; `max-w-md` in Tailwind v4 = 12px not 28rem (use explicit width)

## Commit Style

```
fix: <what broke and how>
feat: <new capability>
docs: <docs/comments only>
```

## Common Tasks

| Task | Command |
|------|---------|
| Dev (frontend) | `cd frontend && npm run dev` |
| Dev (backend) | `cd backend && python run.py` |
| Dev (collab) | `cd hocuspocus-server && npm run dev` |
| Lint (frontend) | `cd frontend && npm run lint` |
| New migration | `cd backend && alembic revision --autogenerate -m "description"` |
| Apply migrations | `cd backend && alembic upgrade head` |
| Run backend tests | `cd backend && python test_<name>.py` |

## Where to Look

| I want to… | Look at… |
|------------|----------|
| Add a backend route | `backend/app/api/<domain>.py` + register in `main.py` |
| Add a frontend API call | `frontend/src/lib/api/<domain>.ts` |
| Change DB schema | `backend/app/models/database_models.py` + new Alembic migration |
| Add editor plugin | `frontend/src/components/editor/plugins/` |
| Add a page | `frontend/src/app/<route>/page.tsx` |
| Change AI prompts | `frontend/src/app/api/ai/command/prompt/` (editor-side) + `backend/app/services/ask_ai/prompt_templates.py` (router-side) |
| Change AI models / rate limits | `backend/app/services/ask_ai/config.yaml` (then restart: startup reconciles the admin catalog) |
| Change a user's AI model | Admin > Users > AI Model (`users.ai_model`); never the client |
| Change RBAC permissions | `backend/app/main.py::ROLE_PERMISSIONS` |
| Add collab feature | `hocuspocus-server/server.js` |

## prod-frontend (demo → multi-user backend integration)

Branch `prod-frontend`: the demo frontend was gutted of all placeholder/seed data
and wired to the real FastAPI backend so everything a user sees comes from the
backend. Online-first content (Yjs/Hocuspocus) with a REST fallback.

**What changed**
- `lib/api/seed.ts` — stripped to `HUES` (presence palette) + `blankContent()`.
  Deleted `CURRENT_USER`, `USERS`, `SEED_DOCS`, seeded content, `userById`.
- `lib/api/auth.ts` — removed `admin/admin` demo login + fake Google/SSO
  (`signInWithProvider`). `login()` is email+password only. Added
  `fetchCurrentUser()` → `GET /auth/me`.
- `lib/api/documents.ts` — full `apiFetch` rewrite onto `/documents*` with a
  backend→`DocSummary` adapter (status map, `version=v{current_version_no}`,
  `ownerId=created_by`). `recent`/`shared` derived client-side; `duplicate` is
  client-side create+copy; `toggleStar` reads state then `PUT/DELETE …/star`;
  `collaboratorCount` kept in UI (defaults to 1, ready for an assignments count).
- `lib/api/comments.ts` — backend-backed reads (`GET /documents/{id}/comments`,
  flat→threaded). Empty `USERS_MAP`/`SEED_DISCUSSIONS`, real `CURRENT_USER_ID`.
  Writes use a transient client cache (full write-through is a follow-up).
- `lib/api/collaborators.ts` — sharing rebuilt on `assignments`/`roles`/`users`/
  `ownership`. `generalAccess` is a client-only toggle (backend has no link
  sharing); `getPresence()` returns the session user (Yjs awareness follow-up).
- `top-nav.tsx` — real session user (cached + `/auth/me`); notifications button
  hits `listNotifications()`. `side-nav.tsx` — dropped fake "Enterprise Plan".
- `login/page.tsx` + `page.tsx` (signup) — removed hardcoded avatar URLs and
  fake social proof; Google/SSO buttons disabled (no backend OAuth).
- `lib/data.ts` — removed the `DOCS` demo array (kept `STATUS_CLASS`).

**Decisions**: Google/SSO disabled (not deleted); `duplicate` client-side;
`collaboratorCount` kept & wired; REST fallback built but online prioritized;
MSW (`src/mocks/*`) kept but left disabled.

**To run multi-user**: set `NEXT_PUBLIC_COLLAB_ENABLED=true` +
`NEXT_PUBLIC_COLLAB_URL` (Hocuspocus) so editor content is Yjs-canonical.
With collab off, the editor opens a blank REST-fallback doc (content not
persisted over REST).

**Production blockers resolved**
- Auth route guard — `components/auth-guard.tsx` (client; `useSyncExternalStore`
  on the token, redirects to `/login`). Wraps `/browser` + the editor.
- Status/approval wiring — `document-store` now resolves the user's backend role
  via `getMyAccess` and exposes `caps`/`uiRole`/`previewRole`; `RoleActions` +
  `RoleBadge` are mounted in `editor-top-bar` (submit/approve/reject hit the real
  versions API).
- Comments write-through — `comments.ts` gained `createComment` (POST) +
  `resolveComment` (PATCH); `discussion-sync` fires best-effort write-through
  (backend ids reconcile on reload).
- Collab fallback non-silent — editor toasts "Offline mode — changes won't be
  saved" when `NEXT_PUBLIC_COLLAB_ENABLED` is off. Deploying Hocuspocus + the
  env var remains an ops step.

**User-name display fixes**
- Comment author names — `discussion-sync` now hydrates the discussion `users`
  map from the org roster (`assignments.listOrgUsers()`) before loading threads,
  then layers the signed-in user on top. Previously only the current user was
  injected, so other users' comments rendered with a blank name/avatar.
- `"(you)"` self-markers — `presence-stack.tsx` and `share-dialog.tsx` compared
  against the old hardcoded `"you"` id (dead since ids are real UUIDs); now
  compared against `getCurrentUser()?.id`.
- Confirmed real session name renders in: browser account menu/avatar
  (`top-nav`), presence stack, share-dialog collaborator list, and comments
  (own + others').

**Follow-ups**: Yjs-awareness presence, deep Yjs content duplication, backend
`updated_at` on the document list item, comment-edit/delete write-through.

## Local-network + doc-creation fixes (commits `5452f33`, `a38ca16`, `aa5b678`)

Earlier work that was committed but not previously documented here.

**Run on a LAN (expose to other machines)**
- `frontend/package.json` — dev script is now `next dev -H 0.0.0.0` (binds all
  interfaces, not just localhost). Backend already binds `0.0.0.0:8000`
  (`run.py`). To use from another device set
  `frontend/.env.local` `NEXT_PUBLIC_API_URL=http://<LAN-IP>:8000/api` (currently
  `http://10.4.8.187:8000/api`). The frontend API base must point at the host's
  LAN IP, not `localhost`, or other machines hit themselves.

**Create documents without pre-existing org/folder** (fixes the `403 Forbidden`
and `invalid UUID 'new'` + double-`POST /documents`):
- `auth.py` signup + `main.py` startup seed a shared **placeholder org/folder**
  (`DEFAULT_ORG_ID`) so a brand-new user can create docs immediately with no
  org/folder setup. `documents.py::create_document` parks root docs in the org
  root folder and grants the creator `owner` on the document scope.
- The `invalid UUID 'new'` crash came from the editor routing the literal id
  `"new"` to the backend; `document-store` now waits for a real created id before
  calling `getMyAccess`/load (guards `resolvedId === "new"`).
- The duplicated `POST /documents` on "New Document" was de-duped in
  `document-store` (single create path).

## Per-user isolation + RBAC enforcement (commit `aa5b678` "3 fixes" + uncommitted)

**Problem found in e2e testing**: every signup joined one shared org AND received
an org-scoped `editor` grant, so (1) `GET /documents` (org-filtered) showed every
user every document, and (2) `resolve_role`'s org fallback let any user EDIT any
document by direct URL. Role-based editor views existed in code but were dead
(`readOnly` was a manual toggle never tied to the resolved role).

**Backend (committed in `aa5b678`)**
- `documents.py::list_documents` — now returns only documents the user CREATED
  (`created_by == me`) OR holds an explicit document-scoped assignment for
  (shared with them). Powers correct "All / Shared with me" views. `or_` import
  added.
- `documents.py::create_document` — root-doc creation no longer requires an
  org-wide edit grant; any authenticated user may create their OWN doc (becomes
  owner via creator-owns). Closes the need for org-editor.
- `auth.py::signup` — REMOVED the org-scoped `editor` assignment. New users get
  no org-wide role; access to other docs comes only from explicit shares.
- `auth-guard.tsx` — fixed hard-load/refresh logging users out: redirect now
  gated behind a `mounted` flag so the first post-hydration render (server
  snapshot `false`) doesn't bounce an authenticated user to `/login`.

**Backend (this session, uncommitted)**
- `main.py` — REMOVED the startup backfill that re-granted org-scoped `editor` to
  every user on every boot. It defeated the isolation fix (re-opened the
  direct-URL edit leak each restart) and is obsolete now that root creation needs
  no org grant. Only the bootstrap admin keeps an org-scoped role (`owner`).
- One-off cleanup already run on the dev DB:
  `DELETE FROM assignments a USING roles r WHERE a.role_id=r.id AND
  a.scope_type='org' AND r.name='editor';` (removed 5 stale grants; 1 admin owner
  kept). Re-run after restoring any old DB dump.

**Frontend role-based controls (this session, uncommitted)** — viewer lockout +
other per-role gates, verified end-to-end with a real shared viewer account:
- `document-store.tsx` — `readOnly` is now `manualToggle || !caps.canEdit`, so a
  viewer (or unresolved/no-access role) is ALWAYS read-only (can't type, can't
  rename, can't trip autosave) regardless of the Viewing/Editing toggle. Also
  exposes `realUiRole`.
- `document-store.tsx` — "Preview as role" can now only DOWNGRADE: previewed caps
  are clamped to the user's real role by rank (`viewer<editor<approver<owner`), so
  a viewer can't preview-as-Owner to escalate to edit client-side. (Was a real
  privilege-escalation hole.)
- `editor-top-bar.tsx` — Share button only rendered for `caps.canManageMembers`
  (owner). Backend also enforces owner-only `POST /assignments`.
- `role-actions.tsx` — preview switcher lists only roles ≤ the user's real role.
  (Submit/Review already correctly gated on `caps`; viewer → null.)
- `comments-panel.tsx` — reply composer gated on `caps.canComment`.
- Enforcement is 3-layer: frontend gates + backend REST (`authorize-check`,
  owner-only share) + collab WS (`READ_ONLY_ROLES = {viewer}` rejects edits).
- VERIFIED: real viewer sees the shared doc, but Share gone, Submit/Review gone,
  reply hidden, title `readOnly`, role badge = Viewer, switcher offers only Viewer.

**Share menu (clarification)** — sharing by name/email with per-doc roles ALREADY
works end-to-end (`collaborators.ts::searchUsers` polls `GET /users` by
name/email → `assignments.assignRole` → `POST /assignments` doc-scoped). It was
just invisible because the editor body is blank and isolation masked it.

## RESOLVED (2026-07-02): blank editor body + production-readiness pass

All nine production issues fixed and verified live (backend smoke test +
browser session against the running stack). Summary of the session's changes:

**Blank editor body — ROOT CAUSE FOUND & FIXED.** With
`skipInitialization: true`, `PlateContent` returns null while
`editor.children` is empty, and NOTHING re-renders it after the async
`yjs.init()` finishes (the creation-time `onReady` that `usePlateEditor` uses
to force a re-render is skipped along with init). Fix: pass `onReady` to
`yjs.init({...})` in `plate-editor.tsx` and bump a state. Also added a
StrictMode single-init guard (re-run reconnects instead of re-initializing) —
kills the dev-only "[yjs] Tried to remove event handler" spam + duplicate WS.

**"new" room bug (document saving).** The Yjs room name was the ROUTE id —
literally `"new"` for every fresh document — so all new docs shared one room
and persistence wrote to `WHERE id='new'` (no row). Room is now the RESOLVED
`doc.id`. Verified: type → `[store] doc=<uuid>` → reload restores content.

**Comments (end-to-end).** `DiscussionSync` was never mounted — now mounted in
`plate-editor.tsx`. Comment ids are client-generated UUIDs shared with the
backend (`CommentCreate.id`, idempotent create), so text marks/plugin
state/backend rows stay in sync across reloads. Anchor (`documentContent`)
persisted. New backend endpoints: `PATCH /comments/{id}` (edit, author-only),
`DELETE /comments/{id}` (author or resolver; root deletes thread).
`discussion-sync.tsx` write-through now covers create/edit/delete/resolve.

**Version diff/restore (backend-backed).** New `versions.content` JSONB
(migration `0006_version_content`) + `POST /documents/{id}/versions`
(kind='snapshot') + content on `GET /versions/{id}` and on
submit-for-approval. `lib/api/snapshots.ts` rewritten onto these (localStorage
store + demo seeds deleted). Version dialog captures the LIVE editor children;
compare diffs snapshot vs live editor; restore applies content to the live
editor (propagates via Yjs — no reload). Submission numbering now uses
max(version_no)+1 so snapshots and submissions never collide.

**Isolation hardening.** `GET /documents/{id}` now requires
`can_view_history` (was: any org member could read metadata).
`hocuspocus-server/auth.js::getUserRole` returns null (connection REJECTED)
instead of defaulting to viewer — the old default let ANY authenticated user
read ANY document's content over WS by UUID. Tests updated (59/59 pass).
`document-store` no longer silently CREATES a new doc when loading an
existing id fails (was spawning blank "Untitled document"s on 403/404/network
errors) — it toasts and returns to /browser.

**Disconnects.** `client.ts::getFreshToken()` (decodes JWT exp, refreshes when
<60s left); the Hocuspocus provider token is now that async fn, so a reconnect
after access-token expiry silently rotates instead of failing auth forever.

**Presence cursors.** Added `@slate-yjs/react` +
`components/ui/remote-cursor-overlay.tsx`, wired via YjsPlugin
`render.afterEditable`. Remote carets/selections render in each user's hue
with a fading name label.

**Access control menu.** Share dialog: proper error toasts on
invite/change/remove (were unhandled rejections), and "Commenter" removed from
assignable roles (it silently granted editor). `components/editor/
access-control-panel.tsx` is dead code (never imported) — candidate for
deletion.

**Branding/UX.** "Docflow" → "Docolab" in layout metadata, top-nav, login,
signup; signup branding panel now vertically centered (matches login); login
field relabelled Email (was "Username"/"admin" demo leftovers). localStorage
keys (`docflow.token` etc.) deliberately KEPT so existing sessions survive the
deploy. Backend list items now include `updated_at` (browser sort/labels work).

**Deploy checklist (Vercel + backend/collab hosts)**
- Vercel env: `NEXT_PUBLIC_API_URL=https://<backend>/api`,
  `NEXT_PUBLIC_COLLAB_URL=wss://<hocuspocus>` (MUST be wss:// on https pages).
  No AI vars — AI now goes to NEXT_PUBLIC_API_URL like every other call. The old
  `GOOGLE_GENERATIVE_AI_API_KEY` is unused by the Ask-AI path (the unmounted
  copilot route still reads it).
- Ask-AI: nothing to deploy — it is part of the backend. Set `GROQ_API_KEY` /
  `GEMINI_API_KEY` / `NVIDIA_API_KEY` on the BACKEND host.
- Backend: deploy with `AUTO_MIGRATE=1` (applies `0012_ask_ai_catalog`) or run
  `alembic upgrade head` manually. CORS_ORIGINS must include the Vercel domain.
- hocuspocus-server: mandatory infra; needs `JWT_SECRET` (= backend
  SECRET_KEY) + `DATABASE_URL`; port open for WSS.

## RESOLVED HISTORY: blank editor document body (the "Yjs gating" problem)

**Symptom**: the editor chrome renders (menus, title, Saved status, role badge,
Share) but the document body is **completely blank** — no `contenteditable` /
`[data-slate-editor]` mounts. `PlateContainer` renders only its empty wrapper;
`PlateContent` returns null. No content can be typed or read.

**Trigger**: the always-on-collab commit (`af8129c` "Enable real-time
collaboration and presence") made the editor hard-depend on Yjs. `plate-editor.tsx`
uses `usePlateEditor({ skipInitialization: true })` and initializes via
`editor.getApi(YjsPlugin).yjs.init({ id, value, autoConnect: true })` in an
effect. `PlateContent` only renders once the editor is initialized, and that init
never completes in this setup → blank body. The old "collab off → blank REST
fallback doc" model documented above is now OBSOLETE (collab is always on; there
is no REST-content fallback path in the editor anymore).

**Debug methods already tried (all RULED OUT)**:
1. *Collab server down* — installed `hocuspocus-server` deps (was missing
   `node_modules`), wrote its `.env` (`JWT_SECRET` = backend `SECRET_KEY`,
   `DATABASE_URL`, `COLLAB_PORT=1234`), started it. Server connects, authenticates
   the user (role=owner), loads the doc, and PERSISTS (`[store] bytes=37`). So the
   WS sync round-trip works — still blank.
2. *React StrictMode double-invoke* — the init/destroy effect ran
   mount→unmount→mount, throwing 42× `[yjs] Tried to remove event handler that
   doesn't exist`. Tried (a) deferred-destroy via a `mounted` ref + microtask, and
   (b) single-init guard via an `initedRef`. Both ELIMINATED the 42 errors and the
   duplicate WS connect (2→1) — but the body stayed blank. Then set
   `reactStrictMode: false` in `next.config.ts` and re-tested: STILL blank. So
   StrictMode is NOT the cause. All of these experimental edits were REVERTED;
   `plate-editor.tsx` and `next.config.ts` are back to their committed state.
3. *Bad seed value* — confirmed `blankContent()` returns a valid Plate value
   `[{ type: "p", children: [{ text: "" }] }]`. Not the cause.
4. *Render gate in the yjs plugin* — inspected `@platejs/yjs` dist; the React
   `YjsPlugin` is just `toPlatePlugin(BaseYjsPlugin)` with no render gate, so the
   null render is in core `PlateContent` (gated on editor-initialized state).

**Untried / next hypotheses**: the `skipInitialization: true` + Yjs `init()`
handshake never marks the editor initialized in this Plate v53 / `@platejs/yjs`
combo. Try: (a) initialize the editor immediately (render the editable) and let
Yjs bind on top instead of gating on sync; (b) check the installed
`@platejs/yjs` version against the Plate v53 example and the exact `init` option
shape; (c) listen for the provider `synced`/`sync` event and confirm whether the
editor's initialized flag ever flips. The editor body MUST render before any
content/collab feature can be verified — this is the top production blocker.

## Production testing — remaining tasks

- [ ] **FIX the blank editor body** (above) — top blocker; nothing in the editor
  (typing, comments anchored to text, AI edits, version diffs, presence cursors)
  can be verified until this renders.
- [ ] **Commit the uncommitted work** — `main.py` (backfill removal),
  `document-store.tsx`, `editor-top-bar.tsx`, `role-actions.tsx`,
  `comments-panel.tsx` (role controls). `.claude/launch.json` is a local preview
  helper (decide whether to track it).
- [ ] **Re-verify viewer content lock by actually typing** once the body renders
  (so far confirmed via the title input + collab WS, not the Plate surface).
- [ ] **Collab is now mandatory infra** — `hocuspocus-server` must be deployed and
  reachable in every environment (deps installed, `.env` set, port 1234 open).
  Update the "To run multi-user" note: there is no usable collab-off mode.
- [ ] **Multi-user live test** — two browsers, same doc: real-time co-editing,
  presence avatars/cursors, viewer rejected at the socket.
- [ ] **Approval flow e2e** — collaborator submits → manager reviews
  (approve/reject + mandatory feedback) → status transitions + version history.
- [ ] **Comments write-through** — confirm `createComment`/`resolveComment` POST
  reconcile with backend ids on reload; implement comment edit/delete.
- [ ] **Notifications** — `listNotifications()` button wiring end-to-end.
- [ ] **Token refresh under load** — 401 → refresh rotation on long sessions and
  on collab WS reconnect (provider re-reads the token).
- [ ] **Trash / star / duplicate** — exercise from the browser against the backend.
- [ ] **Backend test scripts** — run `backend/test_*.py` (httpx) against a clean
  DB; no pytest runner is configured.
- [ ] **Run `npm run lint`** on the frontend before shipping (typecheck this
  session was clean apart from generated `.next` files).
