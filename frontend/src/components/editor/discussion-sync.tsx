"use client";

import * as React from "react";
import { useEditorRef, usePluginOption } from "platejs/react";

import { discussionPlugin } from "@/components/editor/plugins/discussion-kit";
import {
  getDiscussions,
  saveDiscussions,
  createComment,
  resolveComment,
  bodyFromRich,
  type DiscussionUser,
  type TDiscussion,
} from "@/lib/api/comments";
import * as auth from "@/lib/api/auth";
import * as assignments from "@/lib/api/assignments";

const avatar = (seed: string) =>
  `https://api.dicebear.com/9.x/glass/svg?seed=${seed}`;

/**
 * Bridges the discussion plugin's in-memory option store to the (mock) comments
 * API, fixing two bugs in the previous build:
 *
 *  1. **Comments didn't persist.** Inline comment creation only called
 *     `editor.setOption(discussionPlugin, 'discussions', …)` and never wrote
 *     back to storage, so threads were lost on reload. This watches the option
 *     and persists every change (covers inline create, edit, delete, resolve,
 *     and sidebar replies in one place).
 *  2. **The author wasn't the real user.** `currentUserId` was the hard-coded
 *     seed user. We inject the signed-in account so new comments are attributed
 *     to whoever is actually logged in.
 *
 * Rendered inside <Plate> so it can use the editor option hooks.
 */
export function DiscussionSync({ docId }: { docId: string }) {
  const editor = useEditorRef();
  const hydratedRef = React.useRef(false);
  // Comment ids already persisted to the backend (loaded or POSTed this session).
  const syncedRef = React.useRef<Set<string>>(new Set());
  // Last-known resolved state per thread, to detect resolve/unresolve toggles.
  const resolvedRef = React.useRef<Map<string, boolean>>(new Map());
  const discussions = usePluginOption(
    discussionPlugin,
    "discussions",
  ) as TDiscussion[];

  // Hydrate this document's threads + wire the signed-in user as author.
  React.useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false;
    syncedRef.current = new Set();
    resolvedRef.current = new Map();

    (async () => {
      // Build the user map so EVERY comment author resolves to a name/avatar:
      // start from the org roster, then layer the signed-in user on top.
      const usersMap: Record<string, DiscussionUser> = {
        ...(editor.getOption(discussionPlugin, "users") as Record<
          string,
          DiscussionUser
        >),
      };
      try {
        const roster = await assignments.listOrgUsers();
        for (const u of roster) {
          usersMap[u.id] = {
            id: u.id,
            name: u.display_name,
            avatarUrl: avatar(u.id),
          };
        }
      } catch {
        /* backend unreachable — fall back to just the current user below */
      }
      if (cancelled) return;

      const me = auth.getCurrentUser();
      if (me) {
        usersMap[me.id] = { id: me.id, name: me.name, avatarUrl: avatar(me.id) };
        editor.setOption(discussionPlugin, "currentUserId", me.id);
      }
      editor.setOption(discussionPlugin, "users", usersMap);

      const loaded = await getDiscussions(docId);
      if (cancelled) return;
      // Everything loaded from the backend is already persisted.
      for (const d of loaded) {
        resolvedRef.current.set(d.id, d.isResolved);
        for (const c of d.comments) syncedRef.current.add(c.id);
      }
      editor.setOption(discussionPlugin, "discussions", loaded);
      // Mark hydrated only after the initial load is applied, so the persist
      // effect below never clobbers stored threads with the seed value.
      hydratedRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [docId, editor]);

  // Persist changes once hydration has completed: cache locally, then
  // best-effort write-through to the backend (POST new comments, PATCH
  // resolves). Backend ids are reconciled on the next reload.
  React.useEffect(() => {
    if (!hydratedRef.current) return;
    void saveDiscussions(docId, discussions);

    for (const d of discussions) {
      // New comments (client-generated ids not yet synced) -> POST.
      for (const c of d.comments) {
        if (syncedRef.current.has(c.id)) continue;
        syncedRef.current.add(c.id); // optimistic: don't double-POST
        const body = bodyFromRich(c.contentRich);
        if (!body) continue;
        const isReply = c.id !== d.id; // root comment id equals discussion id
        const parentCommentId =
          isReply && syncedRef.current.has(d.id) ? d.id : undefined;
        void createComment(docId, body, { parentCommentId }).catch(() => {
          syncedRef.current.delete(c.id); // allow a retry on next change
        });
      }
      // Resolve / unresolve toggles on known threads -> PATCH.
      const prev = resolvedRef.current.get(d.id);
      if (prev !== undefined && prev !== d.isResolved) {
        resolvedRef.current.set(d.id, d.isResolved);
        void resolveComment(d.id, d.isResolved).catch(() => {});
      } else if (prev === undefined) {
        resolvedRef.current.set(d.id, d.isResolved);
      }
    }
  }, [discussions, docId]);

  return null;
}
