// =============================================================================
// lib/ai-attribution.ts
//
// Persistent attribution for AI-authored text. When an AI edit is accepted we
// stamp the affected text leaves with an `aiEdit` mark carrying who invoked the
// AI and when. The mark travels with the document content (so it survives
// reload and is naturally split/merged by Slate as the text is edited later),
// and the "Show AI Edits" toggle decorates those leaves blue.
//
// This is deliberately mark-based (not an external range store) so it stays
// correct across subsequent edits without range bookkeeping.
// =============================================================================

import { KEYS, TextApi, type SlateEditor } from "platejs";
import { getTransientSuggestionKey } from "@platejs/suggestion";

import { discussionPlugin } from "@/components/editor/plugins/discussion-kit";
import type { DiscussionUser } from "@/lib/api/comments";

/** Leaf mark key holding AI attribution. */
export const AI_EDIT_KEY = "aiEdit" as const;

export interface AiEditMark {
  authorId: string;
  authorName: string;
  ts: number;
}

/** Resolve the signed-in user from the discussion plugin (wired by DiscussionSync). */
export function currentAuthor(editor: SlateEditor): AiEditMark {
  const id = editor.getOption(discussionPlugin, "currentUserId") as string;
  const users = editor.getOption(discussionPlugin, "users") as Record<
    string,
    DiscussionUser
  >;
  return {
    authorId: id ?? "ai",
    authorName: users?.[id]?.name ?? "AI assistant",
    ts: Date.now(),
  };
}

/** Stamp every text leaf in `source` (e.g. an AI sub-editor) with attribution. */
export function markEditorTextAsAi(source: SlateEditor, author: AiEditMark): void {
  source.tf.setNodes(
    { [AI_EDIT_KEY]: author },
    { at: [], match: TextApi.isText, mode: "lowest" },
  );
}

/**
 * Stamp the AI text currently pending in the editor (insert-mode preview leaves
 * carrying `KEYS.ai`, and edit-mode suggestion insertions carrying the transient
 * suggestion key) with attribution, BEFORE the AI accept transform finalizes
 * them. Insertions keep the mark; deletions are removed by accept anyway.
 */
export function stampPendingAiEdits(editor: SlateEditor): void {
  const author = currentAuthor(editor);
  const transientSuggestion = getTransientSuggestionKey();

  editor.tf.setNodes(
    { [AI_EDIT_KEY]: author },
    {
      at: [],
      match: (n) =>
        TextApi.isText(n) && (!!n[KEYS.ai] || !!n[transientSuggestion]),
      mode: "lowest",
      split: true,
    },
  );
}
