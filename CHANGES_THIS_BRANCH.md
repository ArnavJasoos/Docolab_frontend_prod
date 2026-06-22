# Changes — `feature/governance-integration-fixes`

Per-file manifest of everything changed on this branch vs `main` (commit `ebf02d8`).
**19 files · +1824 / −59.** Grouped by the 4 commits.

---

## Commit `597c1b4` — Backend: CORS, .env loading, canonical routes

| File | +/− | What changed |
|---|---|---|
| `backend/app/main.py` | +31/−… | Added `CORSMiddleware` (allows the browser frontend to call the API + preflight). Mounted `versions`/`ai`/`export` routers at the bare `/api` prefix to fix double-prefixed URLs (`/api/versions/documents/...` → `/api/documents/...`). |
| `backend/app/core/config.py` | +23 | Added `CORS_ORIGINS` setting + `cors_origins_list` property; added `load_dotenv(backend/.env)` so settings read `.env`. |
| `backend/app/core/database.py` | +12 | Added `load_dotenv(backend/.env)` before reading `DATABASE_URL`, so a local `.env` is picked up regardless of CWD. |
| `backend/app/api/export.py` | +4/−4 | `Query(..., regex=...)` → `Query(..., pattern=...)` (FastAPI deprecation) on both export endpoints. |

## Commit `5f02067` — Frontend: real backend wiring + API clients

| File | +/− | What changed |
|---|---|---|
| `frontend/src/lib/api/auth.ts` | +79/−… | Replaced the localStorage mock with real `fetch` → `POST /api/auth/signup` & `/login`; stores the JWT via `client.setToken`; maps `name`→`display_name`; `signInWithProvider` now rejects (no OAuth in spec). |
| `frontend/src/lib/api/versions.ts` | +… /−… | Replaced the localStorage mock with real `fetch` → `GET /documents/:id/versions`, `submit-for-approval`, `restore`; maps backend `VersionResponse` → `DocVersion`. |
| `frontend/src/lib/api/client.ts` | +78 | **New.** Base fetch wrapper: base URL (`NEXT_PUBLIC_API_URL`), `Bearer` token from `localStorage`, JSON encoding, `ApiError`. |
| `frontend/src/lib/api/notifications.ts` | +47 | **New.** Real client → `/notifications?unread=true`, `/:id/read`, `/read-all`. |
| `frontend/src/lib/api/ai.ts` | +44 | **New.** Real client → `/documents/:id/ai/suggest`, `/recommendations/:id/ai/apply`, `/ai/jobs/:id`. |
| `frontend/src/lib/api/export.ts` | +46 | **New.** Real client → `/documents/:id/export`, `/versions/:id/export` (+ `downloadDocument` helper). |

## Commit `ae0e8e2` — Frontend: MSW mock layer

| File | +/− | What changed |
|---|---|---|
| `frontend/src/mocks/handlers.ts` | +160 | **New.** Locked API contract — MSW handlers for auth/versions/notifications/ai/export mirroring the backend response shapes. |
| `frontend/src/mocks/browser.ts` | +5 | **New.** `setupWorker` for the browser. |
| `frontend/src/mocks/server.ts` | +11 | **New.** `setupServer` for Node tests. |
| `frontend/src/mocks/mock-provider.tsx` | +33 | **New.** Starts the worker when `NEXT_PUBLIC_API_MOCKING=enabled`; zero cost when off. |
| `frontend/src/app/layout.tsx` | +5/−… | Mounted `<MockProvider>` around the app. |
| `frontend/public/mockServiceWorker.js` | +349 | **New.** Generated MSW service worker script. |
| `frontend/package.json` | +6 | Added `msw` dev dependency + `msw.workerDirectory`. |
| `frontend/package-lock.json` | +564 | Lockfile for the `msw` install. |

## Commit `fe2b034` — Docs

| File | +/− | What changed |
|---|---|---|
| `INTEGRATION_CHANGES.md` | +272 | **New.** Full integration changelog: backend fixes, gitignore root cause, frontend wiring, MSW usage, and the PLATE v2 architecture-conformance audit (§0b). |

---

## Not changed / intentionally excluded
- **`main` branch** — untouched (work kept on the feature branch).
- **`documents.ts`, `comments.ts`, `collaborators.ts`** — still localStorage mocks (other clusters' owners; documents also needs a data-model reconciliation — see `INTEGRATION_CHANGES.md` §0b/§4).
- **Test runner** — Vitest scaffolding was used to verify (12/12 contract tests passed) then removed; not part of the codebase.
