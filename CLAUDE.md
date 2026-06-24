# Docolab — Project Instructions

## Architecture: 3-Service Monorepo

| Service | Dir | Runtime |
|---------|-----|---------|
| Frontend | `frontend/` | Next.js 16 / React 19 / TypeScript |
| Backend | `backend/` | FastAPI / SQLAlchemy async / PostgreSQL |
| Collab WS | `hocuspocus-server/` | Node.js / Hocuspocus / Y.js |

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Language (FE) | TypeScript 5 | strict mode |
| Framework | Next.js 16.2.9 (App Router) | React 19 |
| Editor | Plate.js v53 | `@platejs/*` packages |
| Styling | Tailwind CSS v4 + shadcn/ui | `components.json` driven |
| AI (FE) | Google Gemini (`@ai-sdk/google`) | routes under `src/app/api/ai/` |
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
```

## Environment Variables

**frontend/.env.local**
```
GOOGLE_GENERATIVE_AI_API_KEY=<gemini key>
NEXT_PUBLIC_API_URL=http://localhost:8000/api  # defaults to this if unset
```

**backend/.env** (copy from `.env.example`)
```
DATABASE_URL=postgresql+asyncpg://...
SECRET_KEY=<long random string>   # must match hocuspocus-server JWT_SECRET
ACCESS_TOKEN_EXPIRE_MINUTES=60
REFRESH_TOKEN_EXPIRE_DAYS=30
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
| Change AI prompts | `frontend/src/app/api/ai/command/prompt/` |
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

## KNOWN UNRESOLVED: blank editor document body (the "Yjs gating" problem)

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
