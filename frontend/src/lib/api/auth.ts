// =============================================================================
// lib/api/auth.ts  —  REAL backend integration (was a localStorage stub).
//
// Maps to the FastAPI auth cluster:
//   POST /api/auth/signup   { email, password, display_name } -> { user, token }
//   POST /api/auth/login    { email, password }               -> { user, token }
//
// On success we store the JWT via setToken() (client.ts reads it for every
// subsequent request) and cache the user object in localStorage so the sync
// getCurrentUser() keeps working for components that read it on render.
// =============================================================================

import type { User } from "@/lib/types";
import { read, remove, write } from "@/lib/api/db";
import { apiFetch, setToken, clearToken } from "@/lib/api/client";

const KEY = "session";

export type Provider = "google" | "sso";

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
  token: string;
}

/** Map the backend user onto the frontend User type. */
function toUser(u: UserResponse): User {
  return {
    id: u.id,
    name: u.display_name,
    email: u.email,
  };
}

/** Cached current user for synchronous reads (set on login/signup). */
export function getCurrentUser(): User | null {
  return read<User | null>(KEY, null);
}

function establishSession(result: AuthResult): User {
  setToken(result.token); // client.ts attaches this as the Bearer header
  const user = toUser(result.user);
  write(KEY, user);
  return user;
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

// The backend has no OAuth/SSO endpoint yet (v1 is email + password only).
// Surface a clear message instead of silently faking a session.
export async function signInWithProvider(_provider: Provider): Promise<User> {
  throw new Error("Social sign-in isn't available yet — use email and password.");
}

export async function signOut(): Promise<void> {
  clearToken();
  remove(KEY);
}
