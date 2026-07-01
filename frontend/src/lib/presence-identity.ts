// =============================================================================
// lib/presence-identity.ts — one source of truth for a user's collaboration
// identity (colour + name) shared by two consumers:
//   1. the Yjs cursor overlay  → reads `style` / `selectionStyle`
//   2. the presence avatar stack → reads `userId` / `name` / `hue`
//
// Both read the SAME object out of Yjs awareness (`state.data`), so a user's
// caret colour and their avatar ring colour always match.
// =============================================================================

import type { CSSProperties } from "react";

import type { PresenceHue, User } from "@/lib/types";

// The eight presence hues (matches PresenceHue) and their hex values (kept in
// sync with tailwind.config `presence-*` colours).
const HUES: PresenceHue[] = [
  "violet",
  "fuchsia",
  "orange",
  "teal",
  "rose",
  "lime",
  "sky",
  "amber",
];

const HUE_HEX: Record<PresenceHue, string> = {
  violet: "#7C3AED",
  fuchsia: "#C026D3",
  orange: "#EA580C",
  teal: "#0D9488",
  rose: "#E11D48",
  lime: "#65A30D",
  sky: "#0284C7",
  amber: "#D97706",
};

/** Stable, deterministic hash so a user always maps to the same hue. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Pick a deterministic presence hue for a user id. */
export function hueForUser(userId: string): PresenceHue {
  return HUES[hashString(userId) % HUES.length];
}

export function hexForHue(hue: PresenceHue): string {
  return HUE_HEX[hue];
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The payload written into Yjs awareness `data`. Extends Record so it satisfies
 * the cursor plugin's generic `TCursorData` constraint. Presence fields
 * (userId/name/hue) sit alongside the CSS the cursor overlay consumes.
 */
export interface CursorIdentity extends Record<string, unknown> {
  userId: string;
  name: string;
  hue: PresenceHue;
  color: string;
  /** Caret colour — read by the cursor overlay. */
  style: CSSProperties;
  /** Selection highlight — read by the cursor overlay. */
  selectionStyle: CSSProperties;
}

/** Build the awareness identity for the local user. */
export function buildCursorIdentity(user: User): CursorIdentity {
  const hue = user.hue ?? hueForUser(user.id);
  const color = hexForHue(hue);
  return {
    userId: user.id,
    name: user.name,
    hue,
    color,
    style: { backgroundColor: color },
    selectionStyle: { backgroundColor: hexToRgba(color, 0.2) },
  };
}
