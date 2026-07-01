"use client";

import * as React from "react";
import { usePluginOption } from "platejs/react";
import { YjsPlugin } from "@platejs/yjs/react";

import type { PresenceHue, PresenceUser } from "@/lib/types";

interface AwarenessData {
  userId?: string;
  name?: string;
  hue?: PresenceHue;
}

/**
 * Returns the users currently present in a document, sourced from live Yjs
 * (Hocuspocus) awareness. Each connected client publishes its identity into
 * awareness `data` (see presence-identity / yjs-kit); this hook reads every
 * client's state and de-dupes by real user id (one avatar per user, even with
 * multiple tabs).
 *
 * Must be used inside <Plate> (the YjsPlugin provides the awareness option).
 * The `docId` argument is kept for API compatibility with callers; the room is
 * already bound to the editor's Yjs provider.
 */
export function usePresence(docId: string): PresenceUser[] {
  void docId; // room is bound to the editor's Yjs provider; kept for API compat
  const awareness = usePluginOption(YjsPlugin, "awareness");
  const [users, setUsers] = React.useState<PresenceUser[]>([]);

  React.useEffect(() => {
    if (!awareness) return;

    const build = () => {
      const byUser = new Map<string, PresenceUser>();
      for (const state of awareness.getStates().values()) {
        const data = (state as { data?: AwarenessData })?.data;
        if (!data?.userId) continue;
        byUser.set(data.userId, {
          id: data.userId,
          name: data.name ?? "Anonymous",
          email: "",
          hue: data.hue ?? "violet",
          state: "active",
        });
      }
      setUsers([...byUser.values()]);
    };

    build();
    awareness.on("change", build);
    return () => {
      awareness.off("change", build);
    };
  }, [awareness]);

  return users;
}
