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
import { read, remove, write, latency } from "@/lib/api/db";
import { apiFetch, setToken, clearToken } from "@/lib/api/client";

const KEY = "session";

export type Provider = "google" | "sso";

// Built-in demo account for the showcase build — no backend account required.
// `login()` and the provider buttons short-circuit to a local session so the
// app is explorable without a running auth backend.
const DEMO_USERNAME = "admin";
const DEMO_PASSWORD = "admin";

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

/**
 * Establish a local, backend-free session for the demo build. Used by the
 * built-in admin account and the social/SSO buttons so they actually sign the
 * user in instead of erroring out.
 */
function establishDemoSession(profile: { name: string; email: string }): User {
  const user: User = { id: "demo-admin", name: profile.name, email: profile.email };
  setToken("demo-session"); // placeholder bearer; demo routes don't hit protected endpoints
  write(KEY, user);
  return user;
}

/**
 * Username/password login used by the /login page.
 *
 *   - The demo account `admin` / `admin` logs in instantly (no backend).
 *   - Anything else is treated as an email and sent to the real backend.
 */
export async function login(input: {
  username: string;
  password: string;
}): Promise<User> {
  const username = input.username.trim();

  if (username.toLowerCase() === DEMO_USERNAME && input.password === DEMO_PASSWORD) {
    await latency(); // mirror the network feel of a real sign-in
    return establishDemoSession({ name: "Admin", email: "admin@docflow.local" });
  }

  // Fall back to the real email + password backend.
  if (!username.includes("@")) {
    throw new Error("Invalid username or password.");
  }
  return signIn({ email: username, password: input.password });
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

// The backend has no real OAuth/SSO endpoint yet (v1 is email + password only).
// For the demo build we establish a local session so the Google / SSO buttons
// on the login and registration pages actually sign the user in.
const PROVIDER_PROFILE: Record<Provider, { name: string; email: string }> = {
  google: { name: "Google User", email: "demo@gmail.com" },
  sso: { name: "SSO User", email: "demo@workspace.com" },
};

export async function signInWithProvider(provider: Provider): Promise<User> {
  await latency();
  return establishDemoSession(PROVIDER_PROFILE[provider]);
}

export async function signOut(): Promise<void> {
  clearToken();
  remove(KEY);
}
