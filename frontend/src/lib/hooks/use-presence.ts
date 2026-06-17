"use client";

import * as React from "react";

import type { PresenceUser } from "@/lib/types";
import * as collaborators from "@/lib/api/collaborators";

/**
 * Returns the users currently present in a document. Polls the stub on an
 * interval today; the backend swaps the body for a realtime subscription
 * without changing this hook's contract.
 */
export function usePresence(docId: string, intervalMs = 15_000): PresenceUser[] {
  const [users, setUsers] = React.useState<PresenceUser[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const next = await collaborators.getPresence(docId);
      if (!cancelled) setUsers(next);
    };
    void tick();
    const handle = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [docId, intervalMs]);

  return users;
}
