// =============================================================================
// lib/api/auth.ts  —  real backend auth (no demo shortcuts).
//
// Maps to the FastAPI auth cluster:
//   POST /api/auth/signup   { email, password, display_name } -> { user, token, refresh_token }
//   POST /api/auth/login    { email, password }               -> { user, token, refresh_token }
//   GET  /api/auth/me                                          -> UserResponse
//   POST /api/auth/logout   { refresh_token }
//
// On success we store the JWT via setToken() (client.ts reads it for every
// subsequent request) and cache the user object so the sync getCurrentUser()
// keeps working for components that read it on render.
// =============================================================================

import type { User } from "@/lib/types";
import { read, remove, write } from "@/lib/api/db";
import {
  apiFetch,
  setToken,
  setRefreshToken,
  getRefreshToken,
  clearTokens,
} from "@/lib/api/client";

const KEY = "session";

/** Raw user shape returned by the backend (UserResponse). */
interface UserResponse {
  id: string;
  email: string;
  display_name: string;
  avatar_color?: string | null;
  status: string;
  created_at: string;
}

interface AuthResult {
  user: UserResponse;
  token: string;          // short-lived access token (JWT)
  refresh_token: string;  // long-lived refresh token (rotated on /auth/refresh)
}

/** Map the backend user onto the frontend User type. */
function toUser(u: UserResponse): User {
  return {
    id: u.id,
    name: u.display_name,
    email: u.email,
  };
}

/** Cached current user for synchronous reads (set on login/signup/refresh). */
export function getCurrentUser(): User | null {
  return read<User | null>(KEY, null);
}

/** Fetch the authoritative session user from the backend and refresh the cache. */
export async function fetchCurrentUser(): Promise<User | null> {
  try {
    const u = await apiFetch<UserResponse>("/auth/me");
    const user = toUser(u);
    write(KEY, user);
    return user;
  } catch {
    return null;
  }
}

function establishSession(result: AuthResult): User {
  setToken(result.token);                 // client.ts attaches this as the Bearer header
  setRefreshToken(result.refresh_token);  // used to silently refresh on 401
  const user = toUser(result.user);
  write(KEY, user);
  return user;
}

/**
 * Username/password login used by the /login page. The "username" field is the
 * user's email — the backend authenticates on email + password.
 */
export async function login(input: {
  username: string;
  password: string;
}): Promise<User> {
  const email = input.username.trim();
  return signIn({ email, password: input.password });
}

export async function signUp(input: {
  name: string;
  email: string;
  password: string;
}): Promise<User> {
  if (!input.email.includes("@")) throw new Error("Enter a valid email address.");
  if (input.password.length < 8)
    throw new Error("Password must be at least 8 characters.");

  const result = await apiFetch<AuthResult>("/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      display_name: input.name, // backend expects display_name, UI sends name
    }),
  });
  return establishSession(result);
}

export async function signIn(input: {
  email: string;
  password: string;
}): Promise<User> {
  if (!input.email.includes("@")) throw new Error("Enter a valid email address.");
  if (!input.password) throw new Error("Enter your password.");

  const result = await apiFetch<AuthResult>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: input.email, password: input.password }),
  });
  return establishSession(result);
}

export async function signOut(): Promise<void> {
  // Best-effort server-side revoke of the refresh token, then always clear
  // locally (so logout works even if the backend is unreachable).
  const refresh = getRefreshToken();
  if (refresh) {
    try {
      await apiFetch("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refresh_token: refresh }),
      });
    } catch {
      /* ignore — clear local state regardless */
    }
  }
  clearTokens();
  remove(KEY);
}
