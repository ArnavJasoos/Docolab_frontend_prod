// =============================================================================
// lib/api/comments.ts — document discussions.
//
// Reads are backed by the FastAPI comments cluster:
//   GET /documents/{id}/comments -> { comments: CommentOut[] }
//
// The Plate discussion plugin (discussion-kit.tsx) is initialised with the
// EMPTY defaults below and hydrated per-document at runtime. No seeded users or
// threads remain.
//
// NOTE: inline mutations are cached client-side via saveDiscussions() for now;
// full write-through (POST /documents/{id}/comments, PATCH /comments/{id}/resolve)
// is the remaining follow-up.
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
