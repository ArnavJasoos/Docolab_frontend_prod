# Auth & RBAC, Explained from First Principles

A plain-language guide to how **login, signup, JWT, refresh tokens, logout, and
role-based access control (RBAC)** work in Docolab — *why* each piece exists, and
*how* the frontend and backend are wired together.

Audience: you (the author), so it favours intuition over jargon. Every claim maps
to real code; file paths are given so you can jump to the source.

---

## 0. The two questions every secure app must answer

1. **Authentication ("authN") — *who are you?*** Proving identity. This is
   login/signup/JWT/refresh tokens.
2. **Authorization ("authZ") — *what are you allowed to do?*** Checking
   permission. This is RBAC.

They are different. You can be perfectly authenticated (we know it's you) and
still be *unauthorized* (you can't delete that folder). Docolab keeps them in
separate layers, which is why this doc has two halves.

---

# PART A — AUTHENTICATION

## 1. Passwords: never stored, only "hashed"

**First principle:** if we stored your password as plain text and our database
leaked, every account is instantly compromised. So we never store the password.
We store a **one-way fingerprint** of it called a *hash*.

- A hash is a function that's easy to compute forwards (`password → hash`) but
  practically impossible to reverse (`hash → password`).
- On signup we compute the hash and store *that*.
- On login we hash what you typed and compare it to the stored hash. Same input →
  same hash → match. We never need the original.

**In Docolab** (`backend/app/core/security.py`):

```python
pwd_context = CryptContext(schemes=["argon2", "bcrypt"], deprecated="auto")
```

- **argon2** is the modern, deliberately-slow, memory-hard hashing algorithm
  (slow = expensive for an attacker to brute-force). It's our primary.
- **bcrypt** is kept so any older bcrypt hashes can still be verified.
- `deprecated="auto"` means: if you log in with an old bcrypt hash, it still
  verifies, and we can transparently upgrade you to argon2 later.

> Nuance: argon2 needs the `argon2-cffi` package installed. That's already in
> `requirements.txt`. Without it, signup/login crash with `MissingBackendError`.

---

## 2. The JWT access token: a tamper-proof "wristband"

Once you've proven who you are, the server needs a way to recognise you on *every
later request* without asking for your password each time. That proof is a
**JWT access token**.

**Analogy:** a festival wristband. At the gate you show ID once (login). They give
you a wristband that's hard to forge. After that, every stall just glances at the
wristband — they don't re-check your ID.

**What's actually in a JWT** — three dot-separated parts: `header.payload.signature`

- **payload** — public data. Ours (`security.py`, `create_access_token`):
  ```python
  to_encode = {"exp": expire, "sub": str(user_id)}
  ```
  `sub` = *subject* = the user's id. `exp` = expiry timestamp.
- **signature** — the payload signed with our server secret (`SECRET_KEY`) using
  the `HS256` algorithm.

**The key property — it's tamper-proof, not secret.** Anyone can *read* a JWT
(it's just base64; the payload isn't encrypted). But nobody can *change* it: if an
attacker edits the payload to say `sub: "someone-else"`, the signature no longer
matches, and the server rejects it — because forging a valid signature requires
`SECRET_KEY`, which only the server has.

**Why "stateless"?** The server stores *nothing* about the access token. It
doesn't look it up in a database. To verify, it just re-checks the signature with
`SECRET_KEY` and reads `sub` and `exp`. This makes it fast and scalable.

**The cost of statelessness:** because we don't track it server-side, **we cannot
revoke a JWT once issued.** If it's stolen, it's valid until it expires. The
defence is to keep its lifetime short. Ours: `ACCESS_TOKEN_EXPIRE_MINUTES`
(`.env` sets `60` = 1 hour; code default is 1440 = 24h).

> This "can't revoke + keep it short" trade-off is *exactly* the reason refresh
> tokens (§4) exist.

**How the backend checks it on every request** (`backend/app/api/deps.py`,
`get_current_user`):
1. Pull the token from the `Authorization: Bearer <token>` header.
2. `jwt.decode(token, SECRET_KEY, algorithms=["HS256"])` — verifies the signature
   and that it hasn't expired. Any failure → `401`.
3. Read `sub` → look up that user in the DB.
4. Reject if the user is missing or `disabled`.
5. Return the `User` object — now the endpoint knows who's calling.

Any endpoint that writes `current_user: User = Depends(get_current_user)` is
*protected*: no valid token, no entry.

---

## 3. Signup & Login — the issuing of tokens

### Signup (`POST /api/auth/signup` → `backend/app/api/auth.py::signup`)
1. **Normalise the email to lowercase.** The DB has a unique index on
   `lower(email)`, so `Alice@x.com` and `alice@x.com` are the *same* account. We
   lowercase here so our duplicate check matches the index (otherwise a
   different-case duplicate slips past our friendly `409` and dies on the index as
   an ugly `500`).
2. **Reject duplicates** with `409 Conflict`.
3. **Hash the password** (§1).
4. **Create the user** in the single shared org (`DEFAULT_ORG_ID` — v1 is one
   team/tenant; `org_id` is the multi-tenant hook for later).
5. **Audit** the signup (`record_audit`).
6. **Issue an access token + a refresh token**, commit, return
   `{ user, token, refresh_token }`.

### Login (`POST /api/auth/login` → `auth.py::login`)
1. Lowercase + case-insensitive lookup (mirrors the unique index).
2. `verify_password(typed, stored_hash)` — wrong email *or* wrong password → the
   **same** `401 "Incorrect email or password"`. (Same message on purpose: don't
   reveal whether the email exists — that would help attackers enumerate accounts.)
3. `disabled` account → `403`.
4. Issue access + refresh tokens.
5. `prune_user_tokens` — clean up this user's *expired* refresh rows so the table
   stays small (no cron job needed).
6. Audit, commit, return the same `{ user, token, refresh_token }` shape.

---

## 4. The refresh token: a revocable "locker key"

**The problem it solves.** Access tokens must be short-lived (§2) because we can't
revoke them. But forcing you to retype your password every hour is awful UX. We
need something that (a) lasts a long time, (b) *can* be revoked, and (c) is safe to
keep around. That's the **refresh token**.

**Analogy:** the wristband (access token) is good for an hour. The refresh token is
the locker key you keep in your pocket; when the wristband expires you quietly swap
it at the booth for a fresh wristband — without showing ID again.

**How ours is built** (`backend/app/services/token_service.py`). Four deliberate
security choices:

1. **It's opaque, not a JWT.** Just a long random string
   (`secrets.token_urlsafe(48)`). It carries no readable data — it's a meaningless
   key whose only meaning is "this row exists in our DB."

2. **We store only its hash.** Like passwords, the DB keeps the **SHA-256 hash**,
   never the raw token. So a database leak can't be replayed — the attacker gets
   hashes, not usable tokens.

3. **Rotation — single-use.** Every time you redeem a refresh token at
   `POST /auth/refresh`, the old one is **revoked** and you get a brand-new one.
   A refresh token is therefore used at most once.

4. **Reuse detection — theft mitigation.** Because of rotation, a *valid* refresh
   token should never be presented twice. If an **already-revoked** token shows up,
   that's a red flag: either you or a thief has an old copy. We can't tell which,
   so we **revoke the entire family** (every refresh token for that user) and force
   a fresh login. Whoever stole it is locked out; you just log in again.

   > Nuance in the code (`rotate_refresh_token`): when reuse is detected we
   > `await db.commit()` the family-revocation *before* raising `401`. Otherwise the
   > exception would roll back the very revocation we need to persist.

**Lifetime & cleanup:** refresh tokens live `REFRESH_TOKEN_EXPIRE_DAYS = 30`.
`prune_user_tokens` deletes *expired* rows (harmless — they'd be rejected anyway)
but **keeps revoked-but-unexpired** rows, because those are exactly what
reuse-detection needs to recognise a stolen token within the window.

### The refresh & logout endpoints
- `POST /auth/refresh` (`auth.py::refresh_token`): `rotate_refresh_token` validates
  + rotates → new access token + new refresh token returned. 401 if unknown,
  expired, or revoked.
- `POST /auth/logout` (`auth.py::logout`): `revoke_refresh_token` revokes the one
  token. **Idempotent** — logging out twice still returns success, so the client
  can always clear its state. (This is *real* server-side logout: the refresh token
  is dead immediately; the access token still works until it expires within the
  hour — the short lifetime is what bounds that gap.)

---

## 5. The full token lifecycle (one picture)

```
SIGNUP / LOGIN
   client ── email+password ─────────────► backend
   client ◄── access token (1h, JWT) ──┬── + refresh token (30d, opaque)
                                        │
NORMAL REQUEST                          │  stored in localStorage:
   client ── Bearer <access> ──────────┼─►  docflow.token   = access
   client ◄── 200 + data ──────────────┘    docflow.refresh = refresh

ACCESS TOKEN EXPIRES  →  backend replies 401
   client ── refresh token ──────────► POST /auth/refresh
   client ◄── NEW access + NEW refresh   (old refresh now revoked = rotation)
   client ── retries original request with new access ──► 200

LOGOUT
   client ── refresh token ──────────► POST /auth/logout  (refresh revoked)
   client clears localStorage
```

---

# PART B — AUTHORIZATION (RBAC)

## 6. Why roles, and why a *hierarchy*

Now the server knows *who* you are. The next question is *what may you do here?*

The naive approach — store a permission for every (user, document) pair — explodes:
1,000 users × 10,000 docs = 10 million rows, and a nightmare to keep correct.

**RBAC** (Role-Based Access Control) collapses that. You don't grant permissions to
people directly. You:
1. Define a few **roles** (owner, approver, editor, viewer).
2. Attach a set of **permissions** to each role *once*.
3. **Assign** a person a role *on a scope* (a document, a folder, or the whole org).

Permissions then flow: **person → role → permissions**, evaluated **on a scope**.

### Scopes and inheritance — the core idea
Documents live in folders; folders nest inside folders; everything lives in an org.
A role you hold on a *folder* should apply to everything inside it — otherwise
you'd re-grant access on every new document. So permission resolution **walks up
the tree** until it finds an assignment:

```
        org           ← ultimate authority (org-admin); checked LAST as a fallback
         │
      folder (root)
         │
      folder (child)
         │
      document        ← most specific; checked FIRST (can override what's above)
```

Most specific wins: a role set *directly on a document* overrides whatever you'd
inherit from its folder.

---

## 7. How resolution actually runs (`backend/app/services/auth_service.py`)

Three layers, each tiny and built on the one below:

### `resolve_role(user, scope_type, scope_id)` — *what role do I effectively have here?*
Walks the hierarchy, returns the **first** assignment it finds:
- Start at the **document** → if no direct assignment, jump to its **folder**.
- Folder has no assignment → climb to its **parent folder**, repeat.
- Reached the **root folder** with still nothing → fall back to **org** scope.
  An org-scoped assignment (org-admin) is the final authority over everything.
- `org` is **terminal** — there's nothing above it, so the walk stops.
- Found nothing anywhere → `(None, None, None)` (no role → no access).

> This is the *single* place the walk lives. Everything else builds on it, so
> there's no duplicated, drifting logic. (The Hocuspocus collab server mirrors this
> exact walk in `hocuspocus-server/auth.js` so live-editing permissions match the
> REST API — including the org fallback.)

### `authorize(user, permission, scope_type, scope_id)` — *does my role grant this one permission?*
1. `resolve_role(...)` → my effective role here.
2. Look in `role_permissions` for `(role_id, permission)`.
3. Return `True/False` (+ role name and which scope granted it, for audit logs).

### `require_permission(...)` — *the one guard every write goes through*
Calls `authorize`; if `False`, raises **`403 Forbidden`**. This is the single
choke-point each mutating endpoint calls *before* changing state. One guard → no
endpoint can "forget" to check, and the rule lives in one place.

```python
# every mutating endpoint, before it does anything:
await require_permission(db, user.id, "can_edit_direct", "document", doc_id)
# ... only runs if the line above didn't raise 403
```

### `is_org_admin(user)` — the deliberate exception
Org-admin is **not** inferred from owning folders/documents. Why? Because
"creator-owns" gives *every* user owner rights on *something*, so inferring admin
from ownership would make everyone an admin. Instead it's an explicit **org-scoped
assignment** with `can_manage_members`. Org scope is the separate, intentional
signal for "runs the whole team."

---

## 8. The roles and what they can do

Four roles (the old `suggester` was removed as redundant). The permission catalogue
and full table live in **`RBAC.md`**; the essentials:

| Role | Idea | Key permissions |
|------|------|-----------------|
| **viewer** | read-only | view |
| **editor** | does the work | view, `can_edit_direct`, **`can_submit_for_approval`** |
| **approver** | reviews & signs off | everything editor has + **`can_edit_direct`** + approve |
| **owner** | controls the resource | all of the above + manage members / settings |

Two deliberate design decisions baked in:
- **editors can submit for approval** — submitting your own work for review is an
  intrinsic part of *doing* the work, not a separate privilege.
- **approvers can also edit directly** (`can_edit_direct`) — a reviewer fixing a
  typo shouldn't have to bounce it back.

**Default when you create something — "creator-owns":** make a folder or document
and you get an **owner** assignment on it automatically. That's why
`createDocument` in the frontend first creates a folder you own, then puts the doc
inside it — you're guaranteed to have rights there.

> Known backend nuance (flagged, not yet fixed): creating a doc at the org root
> (`folder_id: null`) checks scope `"organization"`, but the rest of the system
> uses `"org"`, so root-level creation 403s for everyone. The frontend sidesteps it
> by always creating inside an owned folder. One-line fix:
> `"organization"` → `"org"` in `backend/app/api/documents.py`.

---

# PART C — HOW FRONTEND & BACKEND ARE WIRED

## 9. One front door: `apiFetch` (`frontend/src/lib/api/client.ts`)

Every backend call goes through `apiFetch`, so auth, base URL, JSON, errors, and
token-refresh live in **one** place. On each call it:
1. Sets the base URL (`NEXT_PUBLIC_API_URL`, default `http://localhost:8000/api`).
2. Attaches `Authorization: Bearer <access token>` (read from `localStorage`).
3. Sends the request.
4. **On `401`** (access token expired): silently calls `/auth/refresh`, stores the
   new pair, and **retries the original request once**. If refresh fails → clears
   tokens and bounces to `/login`.

**Two important nuances:**
- **Single-flight refresh** (`refreshInFlight`): if ten requests `401` at once,
  they all `await` **one** shared refresh call. Without this, ten parallel
  refreshes would each rotate the token, and nine would look like *reuse* —
  tripping reuse-detection and nuking the whole family. (Subtle but critical.)
- **`NO_REFRESH_PATHS`** (`/auth/login`, `/auth/signup`, `/auth/refresh`,
  `/auth/logout`): a `401` from these means *bad credentials*, not an expired
  session — refreshing would loop. `/auth/me` is intentionally **not** in this list:
  it's a normal protected call that *should* refresh on `401`.

## 10. Where the session is stored (`frontend/src/lib/api/auth.ts`)

On successful login/signup, `establishSession` writes three things to
`localStorage`:

| Key | Value | Read by |
|-----|-------|---------|
| `docflow.token` | access token (JWT) | `apiFetch` → Bearer header |
| `docflow.refresh` | refresh token | the silent-refresh flow |
| `session` | the user object `{ id, name, email }` | `getCurrentUser()` (sync reads) |

- `getCurrentUser()` reads the cached `session` object synchronously, so components
  can show *who's logged in* without an async call.
- **Demo mode:** the `admin/admin` account and the Google/SSO buttons call
  `establishDemoSession`, which sets the access token to the literal string
  `"demo-session"` and clears the refresh token. The document layer's `realToken()`
  treats `"demo-session"` as "not real," so the demo stays on local mock data and
  never hits the backend — clean separation, no half-real state.

## 11. The endpoint map (frontend call → backend handler)

| User action | Frontend (`auth.ts`) | HTTP | Backend (`api/auth.py`) |
|-------------|----------------------|------|--------------------------|
| Register | `signUp()` | `POST /api/auth/signup` | `signup()` |
| Log in | `signIn()` / `login()` | `POST /api/auth/login` | `login()` |
| (auto) token refresh | `refreshAccessToken()` in `client.ts` | `POST /api/auth/refresh` | `refresh_token()` |
| Log out | `signOut()` | `POST /api/auth/logout` | `logout()` |
| Who am I (protected) | any `apiFetch` | `GET /api/auth/me` | `get_me()` |

Every **protected** endpoint (documents, folders, versions, …) depends on
`get_current_user` (authN) and then calls `require_permission` (authZ) before it
mutates anything.

---

## 12. The whole story in three sentences

1. **AuthN:** you prove identity once (password, hashed with argon2); we hand you a
   short-lived tamper-proof **JWT access token** for everyday requests and a
   long-lived, revocable, rotating **refresh token** to silently get new access
   tokens.
2. **AuthZ:** for each action, the backend resolves your **effective role** by
   walking document → folder → parents → org, checks that role grants the needed
   **permission**, and `require_permission` blocks you with `403` if not.
3. **Wiring:** the frontend funnels every call through `apiFetch`, which attaches
   the token, auto-refreshes once on `401`, and keeps the demo build cleanly
   separated from real backend sessions.

---

## 13. Why these choices (the first-principles summary)

| Choice | The fear it addresses |
|--------|----------------------|
| Hash passwords (argon2) | DB leak ⇒ don't hand attackers usable passwords |
| Short-lived JWT | Can't revoke a stateless token ⇒ limit its blast radius |
| Stateless JWT | Speed/scale ⇒ verify by signature, no DB lookup per request |
| Refresh token (opaque, hashed) | Long sessions *and* revocability + leak-safe |
| Rotation + reuse-detection | A stolen refresh token must betray itself |
| Single-flight refresh (client) | Parallel refreshes must not look like theft |
| RBAC + scope-walk | Per-(user,doc) grants explode; roles + inheritance scale |
| One `require_permission` guard | A check in one place can't be forgotten |
| Org-admin only via org scope | "creator-owns" must not accidentally mint admins |
```
