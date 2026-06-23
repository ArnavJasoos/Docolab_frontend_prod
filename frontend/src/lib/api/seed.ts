import type { Value } from "platejs";

import type { PresenceHue } from "@/lib/types";

// Presence colour palette assigned to live collaborators (Yjs awareness).
// This is the only non-user-data constant that survives the demo gut — it is
// pure presentation, not seeded content.
export const HUES: PresenceHue[] = [
  "violet",
  "teal",
  "amber",
  "rose",
  "sky",
  "lime",
  "fuchsia",
  "orange",
];

/** A genuinely blank document body — a single empty paragraph. */
export function blankContent(): Value {
  return [{ type: "p", children: [{ text: "" }] }];
}
