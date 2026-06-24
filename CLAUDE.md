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
