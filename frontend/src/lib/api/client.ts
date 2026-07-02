// =============================================================================
// lib/api/client.ts
// Shared fetch wrapper for talking to the FastAPI backend.
//
// Every api module (versions, notifications, ai, export, …) calls apiFetch()
// so auth, base URL, JSON encoding, error handling, and silent token refresh
// live in one place.
//
// Base URL precedence:
//   NEXT_PUBLIC_API_URL  (set in frontend/.env.local)  →  http://localhost:8000/api
// =============================================================================

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000/api";

const TOKEN_KEY = "docflow.token";
const REFRESH_KEY = "docflow.refresh";

// --- access token -----------------------------------------------------------
/** Read the bearer (access) token saved at sign-in (browser only). */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
}

// --- refresh token ----------------------------------------------------------
export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFRESH_KEY);
}
export function setRefreshToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REFRESH_KEY, token);
}
export function clearRefreshToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(REFRESH_KEY);
}

/** Clear both tokens (sign-out / session expiry). */
export function clearTokens(): void {
  clearToken();
  clearRefreshToken();
}

/** Error thrown for any non-2xx response, carrying the backend's detail. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// --- silent refresh ---------------------------------------------------------
// A single in-flight refresh shared by all callers: if several requests 401 at
// once, they await ONE /auth/refresh instead of each rotating the refresh token
// (which would trip the backend's reuse-detection and revoke the whole family).
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const refresh = getRefreshToken();
  if (!refresh) return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refresh }),
        });
        if (!res.ok) return null; // expired/revoked refresh token
        const data = (await res.json()) as { token: string; refresh_token: string };
        setToken(data.token);
        setRefreshToken(data.refresh_token); // rotation: store the new pair
        return data.token;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/** Seconds-since-epoch `exp` claim of a JWT, or null if unreadable. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1])) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Return an access token that is valid for at least ~60 more seconds,
 * refreshing it first when it is expired or about to expire.
 *
 * Used by the collaboration WebSocket: the provider re-authenticates with this
 * on every (re)connect, so a reconnect that happens after the short-lived
 * access token expired silently rotates it instead of failing auth forever.
 */
export async function getFreshToken(): Promise<string | null> {
  const token = getToken();
  if (!token) return null;
  const exp = tokenExpiry(token);
  if (exp !== null && exp - Date.now() / 1000 < 60) {
    const refreshed = await refreshAccessToken();
    return refreshed ?? getToken();
  }
  return token;
}

// Endpoints that must NOT trigger a refresh-retry: a 401 from these is a real
// auth failure (bad password / expired-or-revoked refresh token), not an expired
// access token — refreshing there would loop. (Note: /auth/me is intentionally
// NOT here — it's a normal protected call that should refresh on 401.)
const NO_REFRESH_PATHS = ["/auth/login", "/auth/signup", "/auth/refresh", "/auth/logout"];

/** Session is truly over: clear tokens and bounce to the login page. */
function onSessionExpired(): void {
  clearTokens();
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

/**
 * Typed fetch against the backend.
 *
 *   const v = await apiFetch<VersionList>(`/documents/${id}/versions`);
 *
 * `path` is relative to API_BASE_URL and must start with "/". On a 401 it
 * transparently refreshes the access token once and retries; if that fails the
 * session is cleared and the user is sent to /login.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const doFetch = (): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body) {
      headers.set("Content-Type", "application/json");
    }
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  };

  let res = await doFetch();

  // Auto-refresh once on 401 — but never for the credential endpoints
  // (a 401 from /auth/login is a bad password, not an expired session, and
  // refreshing /auth/refresh would loop).
  if (res.status === 401 && !NO_REFRESH_PATHS.some((p) => path.startsWith(p))) {
    const newAccess = await refreshAccessToken();
    if (newAccess) {
      res = await doFetch(); // retry once with the fresh access token
    } else {
      onSessionExpired();
      throw new ApiError(401, "Session expired. Please sign in again.");
    }
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.detail ?? detail;
    } catch {
      /* response had no JSON body */
    }
    throw new ApiError(res.status, detail);
  }

  // 204 No Content / empty body
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
