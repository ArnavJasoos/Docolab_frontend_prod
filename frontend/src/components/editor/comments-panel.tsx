"use client";

import * as React from "react";
import { useEditorRef, usePluginOption } from "platejs/react";

import type { TDiscussion, DiscussionUser } from "@/lib/api/comments";
import { discussionPlugin } from "@/components/editor/plugins/discussion-kit";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { uid } from "@/lib/api/db";
import { saveDiscussions } from "@/lib/api/comments";
import { useDocument } from "@/lib/store/document-store";

type RichNode = { text?: string; children?: RichNode[] };

function richText(value: RichNode[] | undefined): string {
  if (!value) return "";
  return value
    .map((n) => n.text ?? richText(n.children))
    .join("");
}

function ago(date: Date): string {
  const diff = Date.now() - new Date(date).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function CommentRow({
  text,
  user,
  date,
}: {
  text: string;
  user?: DiscussionUser;
  date: Date;
}) {
  return (
    <div className="flex gap-2.5">
      <Avatar size="sm" className="mt-0.5">
        {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.name} />}
        <AvatarFallback>{(user?.name ?? "?").charAt(0)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-ui-sm text-ui-sm font-semibold text-text-primary">
            {user?.name ?? "Unknown"}
          </span>
          <span className="font-ui-xs text-ui-xs text-text-muted">{ago(date)}</span>
        </div>
        <p className="font-ui-sm text-ui-sm whitespace-pre-wrap break-words text-text-secondary">
          {text}
        </p>
      </div>
    </div>
  );
}

function DiscussionCard({
  discussion,
  users,
  currentUserId,
  onReply,
  onToggleResolved,
}: {
  discussion: TDiscussion;
  users: Record<string, DiscussionUser>;
  currentUserId: string;
  onReply: (id: string, text: string) => void;
  onToggleResolved: (id: string) => void;
}) {
  const [draft, setDraft] = React.useState("");

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onReply(discussion.id, text);
    setDraft("");
  };

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-bright p-3 shadow-sm">
      {discussion.documentContent && (
        <p className="mb-2 border-l-2 border-status-warning/70 bg-status-warning/5 px-2 py-1 font-ui-xs text-ui-xs italic text-text-secondary">
          “{discussion.documentContent}”
        </p>
      )}

      <div className="space-y-3">
        {discussion.comments.map((c) => (
          <CommentRow
            key={c.id}
            text={richText(c.contentRich as RichNode[])}
            user={users[c.userId]}
            date={c.createdAt}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          onClick={() => onToggleResolved(discussion.id)}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 font-ui-xs text-ui-xs font-semibold transition-colors",
            discussion.isResolved
              ? "text-text-muted hover:bg-surface-container"
              : "text-insertion-text hover:bg-insertion-bg",
          )}
        >
          <Icon name={discussion.isResolved ? "refresh" : "check_circle"} size={15} />
          {discussion.isResolved ? "Reopen" : "Resolve"}
        </button>
      </div>

      {!discussion.isResolved && (
        <div className="mt-2 flex items-center gap-2 border-t border-border-subtle pt-2">
          <Avatar size="sm">
            {users[currentUserId]?.avatarUrl && (
              <AvatarImage src={users[currentUserId].avatarUrl} alt="You" />
            )}
            <AvatarFallback>Y</AvatarFallback>
          </Avatar>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Reply…"
            className="flex-1 bg-transparent font-ui-sm text-ui-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          {draft.trim() && (
            <button
              onClick={send}
              aria-label="Send reply"
              className="flex size-7 items-center justify-center rounded-full bg-primary-container text-on-primary hover:bg-accent-hover"
            >
              <Icon name="arrow_upward" size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CommentsPanel() {
  const editor = useEditorRef();
  const { docId, setCommentsOpen } = useDocument();
  const discussions = usePluginOption(discussionPlugin, "discussions") as TDiscussion[];
  const users = usePluginOption(discussionPlugin, "users") as Record<string, DiscussionUser>;
  const currentUserId = usePluginOption(discussionPlugin, "currentUserId") as string;
  const [tab, setTab] = React.useState<"open" | "resolved">("open");

  const commit = React.useCallback(
    (next: TDiscussion[]) => {
      editor.setOption(discussionPlugin, "discussions", next);
      void saveDiscussions(docId, next);
    },
    [editor, docId],
  );

  const reply = React.useCallback(
    (id: string, text: string) => {
      const next = discussions.map((d) =>
        d.id === id
          ? {
              ...d,
              comments: [
                ...d.comments,
                {
                  id: uid("c"),
                  userId: currentUserId,
                  discussionId: id,
                  contentRich: [{ type: "p", children: [{ text }] }],
                  createdAt: new Date(),
                  isEdited: false,
                },
              ],
            }
          : d,
      );
      commit(next);
    },
    [discussions, currentUserId, commit],
  );

  const toggleResolved = React.useCallback(
    (id: string) => {
      commit(
        discussions.map((d) =>
          d.id === id ? { ...d, isResolved: !d.isResolved } : d,
        ),
      );
    },
    [discussions, commit],
  );

  const openList = discussions.filter((d) => !d.isResolved);
  const resolvedList = discussions.filter((d) => d.isResolved);
  const list = tab === "open" ? openList : resolvedList;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border-subtle bg-panel-surface">
      <header className="flex items-center justify-between px-4 py-3">
        <h2 className="font-ui-base text-ui-base font-semibold text-text-primary">
          Comments
        </h2>
        <button
          onClick={() => setCommentsOpen(false)}
          aria-label="Close comments"
          className="flex size-7 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
        >
          <Icon name="close" size={18} />
        </button>
      </header>

      <div className="flex gap-1 px-3 pb-2">
        {(["open", "resolved"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 rounded-md py-1.5 font-ui-sm text-ui-sm font-medium capitalize transition-colors",
              tab === t
                ? "bg-surface-container text-text-primary"
                : "text-text-muted hover:bg-surface-container-low",
            )}
          >
            {t} · {t === "open" ? openList.length : resolvedList.length}
          </button>
        ))}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-4">
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-text-muted">
            <Icon name={tab === "open" ? "forum" : "task_alt"} size={32} />
            <p className="font-ui-sm text-ui-sm">
              {tab === "open"
                ? "No open comments. Select text and use the comment button to start a thread."
                : "No resolved comments yet."}
            </p>
          </div>
        ) : (
          list.map((d) => (
            <DiscussionCard
              key={d.id}
              discussion={d}
              users={users}
              currentUserId={currentUserId}
              onReply={reply}
              onToggleResolved={toggleResolved}
            />
          ))
        )}
      </div>
    </aside>
  );
}
