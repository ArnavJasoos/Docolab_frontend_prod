// =============================================================================
// lib/api/client.ts
// Shared fetch wrapper for talking to the FastAPI backend.
//
// Every api module (versions, notifications, ai, export, …) calls apiFetch()
// so auth, base URL, JSON encoding, and error handling live in one place.
//
// Base URL precedence:
//   NEXT_PUBLIC_API_URL  (set in frontend/.env.local)  →  http://localhost:8000/api
// =============================================================================

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000/api";

const TOKEN_KEY = "docflow.token";

/** Read the bearer token saved at sign-in (browser only). */
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

/** Error thrown for any non-2xx response, carrying the backend's detail. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Typed fetch against the backend.
 *
 *   const v = await apiFetch<VersionList>(`/documents/${id}/versions`);
 *
 * `path` is relative to API_BASE_URL and must start with "/".
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });

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
