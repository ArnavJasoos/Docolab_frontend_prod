/**
 * Tiny localStorage-backed persistence used by the API stubs.
 *
 * This is the seam the real backend replaces: every function in `lib/api/*`
 * reads/writes through here today, and swapping these helpers (or the callers)
 * for `fetch`/Supabase calls is the only remaining integration work.
 */

const PREFIX = "docflow:";

export function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function write<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota or serialization error — ignore in the stub layer */
  }
}

export function remove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Simulate network latency so optimistic UI + spinners are exercised. */
export function latency(ms = 220): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let counter = 0;
/** Collision-resistant id without pulling in a uuid dependency. */
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
