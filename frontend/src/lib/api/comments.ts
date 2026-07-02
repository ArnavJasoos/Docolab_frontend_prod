// =============================================================================
// lib/api/comments.ts — document discussions, fully backend-backed.
//
//   GET    /documents/{id}/comments  -> { comments: CommentOut[] }
//   POST   /documents/{id}/comments  (client supplies the UUID so the comment
//                                     mark anchored in the Yjs text and the
//                                     backend row share one id)
//   PATCH  /comments/{id}            edit body
//   PATCH  /comments/{id}/resolve    resolve/reopen a thread
//   DELETE /comments/{id}            delete (root deletes the whole thread)
//
// The Plate discussion plugin (discussion-kit.tsx) is initialised with the
// EMPTY defaults below and hydrated per-document at runtime by DiscussionSync.
// =============================================================================

import type { Value } from "platejs";

import type { TComment } from "@/components/ui/comment";
import { latency, read, write } from "@/lib/api/db";
import { apiFetch } from "@/lib/api/client";
import { getCurrentUser } from "@/lib/api/auth";

export type TDiscussion = {
  id: string;
  comments: TComment[];
  createdAt: Date;
  isResolved: boolean;
  userId: string;
  documentContent?: string;
};

export type DiscussionUser = {
  id: string;
  name: string;
  avatarUrl: string;
  hue?: number;
};

/** Empty initial user map; hydrated at runtime from the backend roster. */
export const USERS_MAP: Record<string, DiscussionUser> = {};

/** Current session user id (client-only; empty during SSR). */
export const CURRENT_USER_ID =
  typeof window !== "undefined" ? getCurrentUser()?.id ?? "" : "";

/** No seeded threads — discussions are loaded per-document from the backend. */
export const SEED_DISCUSSIONS: TDiscussion[] = [];

const keyFor = (docId: string) => `discussions:${docId}`;

// --- backend shape -----------------------------------------------------------
interface CommentOut {
  id: string;
  document_id: string;
  suggestion_id: string | null;
  anchor: Record<string, unknown> | null;
  author_id: string;
  body: string;
  is_resolved: boolean;
  parent_comment_id: string | null;
  created_at: string;
}

function richFromBody(body: string): Value {
  return [{ type: "p", children: [{ text: body }] }];
}

/** Flatten a Plate rich value to plain text for the backend `body` field. */
export function bodyFromRich(rich: Value | undefined): string {
  if (!rich) return "";
  const walk = (nodes: unknown[]): string =>
    nodes
      .map((n) => {
        const node = n as { text?: string; children?: unknown[] };
        if (typeof node.text === "string") return node.text;
        if (Array.isArray(node.children)) return walk(node.children);
        return "";
      })
      .join("");
  return walk(rich as unknown[]).trim();
}

/** Create a comment on a document. The caller passes the client-generated
 *  UUID (`id`) so the editor's comment mark and the backend row stay in sync. */
export async function createComment(
  docId: string,
  body: string,
  opts?: { id?: string; parentCommentId?: string; anchor?: Record<string, unknown> },
): Promise<string> {
  const res = await apiFetch<CommentOut>(`/documents/${docId}/comments`, {
    method: "POST",
    body: JSON.stringify({
      id: opts?.id ?? null,
      body,
      parent_comment_id: opts?.parentCommentId ?? null,
      anchor: opts?.anchor ?? null,
    }),
  });
  return res.id;
}

/** Edit a comment's text (author only, enforced server-side). */
export async function updateComment(commentId: string, body: string): Promise<void> {
  await apiFetch(`/comments/${commentId}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

/** Delete a comment; deleting a thread root deletes its replies too. */
export async function deleteComment(commentId: string): Promise<void> {
  await apiFetch(`/comments/${commentId}`, { method: "DELETE" });
}

/** Resolve / unresolve a comment thread (PATCH /comments/{id}/resolve). */
export async function resolveComment(
  commentId: string,
  isResolved: boolean,
): Promise<void> {
  await apiFetch(`/comments/${commentId}/resolve`, {
    method: "PATCH",
    body: JSON.stringify({ is_resolved: isResolved }),
  });
}

/** Group flat backend comments into threaded discussions (root + replies). */
function toDiscussions(comments: CommentOut[]): TDiscussion[] {
  const roots = comments.filter((c) => !c.parent_comment_id);
  return roots.map((root) => {
    const thread = [root, ...comments.filter((c) => c.parent_comment_id === root.id)];
    return {
      id: root.id,
      userId: root.author_id,
      createdAt: new Date(root.created_at),
      isResolved: root.is_resolved,
      // The quoted text the thread was anchored to, persisted in `anchor`.
      documentContent:
        typeof root.anchor?.documentContent === "string"
          ? (root.anchor.documentContent as string)
          : undefined,
      comments: thread.map(
        (c): TComment => ({
          id: c.id,
          userId: c.author_id,
          discussionId: root.id,
          contentRich: richFromBody(c.body),
          createdAt: new Date(c.created_at),
          isEdited: false,
        }),
      ),
    };
  });
}

/** Revive Date fields that JSON round-tripping flattens to strings. */
function reviveDates(discussions: TDiscussion[]): TDiscussion[] {
  return discussions.map((d) => ({
    ...d,
    createdAt: new Date(d.createdAt),
    comments: d.comments.map((c) => ({ ...c, createdAt: new Date(c.createdAt) })),
  }));
}

export async function getDiscussions(docId: string): Promise<TDiscussion[]> {
  try {
    const data = await apiFetch<{ comments: CommentOut[] }>(
      `/documents/${docId}/comments`,
    );
    const discussions = toDiscussions(data.comments);
    write(keyFor(docId), discussions); // cache for transient client mutations
    return discussions;
  } catch {
    // Backend unreachable — fall back to any client-cached discussions.
    await latency(60);
    const stored = read<TDiscussion[] | null>(keyFor(docId), null);
    return stored ? reviveDates(stored) : [];
  }
}

/** Persist the full discussion list (transient client cache for now). */
export async function saveDiscussions(
  docId: string,
  discussions: TDiscussion[],
): Promise<void> {
  write(keyFor(docId), discussions);
}
