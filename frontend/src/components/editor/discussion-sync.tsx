"use client";

import * as React from "react";
import { useEditorRef, usePluginOption } from "platejs/react";

import { discussionPlugin } from "@/components/editor/plugins/discussion-kit";
import {
  getDiscussions,
  saveDiscussions,
  type DiscussionUser,
  type TDiscussion,
} from "@/lib/api/comments";
import * as auth from "@/lib/api/auth";

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
  const discussions = usePluginOption(
    discussionPlugin,
    "discussions",
  ) as TDiscussion[];

  // Hydrate this document's threads + wire the signed-in user as author.
  React.useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false;

    (async () => {
      const me = auth.getCurrentUser();
      if (me) {
        const meUser: DiscussionUser = {
          id: me.id,
          name: me.name,
          avatarUrl: avatar(me.id),
        };
        const users = editor.getOption(discussionPlugin, "users") as Record<
          string,
          DiscussionUser
        >;
        editor.setOption(discussionPlugin, "users", {
          ...users,
          [me.id]: meUser,
        });
        editor.setOption(discussionPlugin, "currentUserId", me.id);
      }

      const loaded = await getDiscussions(docId);
      if (cancelled) return;
      editor.setOption(discussionPlugin, "discussions", loaded);
      // Mark hydrated only after the initial load is applied, so the persist
      // effect below never clobbers stored threads with the seed value.
      hydratedRef.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [docId, editor]);

  // Persist any change to threads once hydration has completed.
  React.useEffect(() => {
    if (!hydratedRef.current) return;
    void saveDiscussions(docId, discussions);
  }, [discussions, docId]);

  return null;
}
