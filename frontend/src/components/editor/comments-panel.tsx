"use client";

import * as React from "react";
import { useEditorRef, usePluginOption } from "platejs/react";
import { getCommentKey } from "@platejs/comment";
import { AIChatPlugin, acceptAISuggestions, rejectAISuggestions } from "@platejs/ai/react";
import { toast } from "sonner";
import { stampPendingAiEdits } from "@/lib/ai-attribution";

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
  onAiEdit,
  isAiEditing,
  aiStreamDone,
  onAiApprove,
  onAiReject,
}: {
  discussion: TDiscussion;
  users: Record<string, DiscussionUser>;
  currentUserId: string;
  onReply: (id: string, text: string) => void;
  onToggleResolved: (id: string) => void;
  onAiEdit: (d: TDiscussion) => void;
  isAiEditing: boolean;
  aiStreamDone: boolean;
  onAiApprove: () => void;
  onAiReject: () => void;
}) {
  const { caps } = useDocument();
  const [draft, setDraft] = React.useState("");

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onReply(discussion.id, text);
    setDraft("");
  };

  return (
    <div
      className={cn(
        "rounded-xl border border-border-subtle bg-surface-bright p-3 shadow-sm transition-opacity",
        discussion.isResolved && "bg-surface-container opacity-60",
      )}
    >
      {discussion.isResolved && (
        <div className="mb-2 flex items-center gap-1 font-ui-xs text-ui-xs font-semibold uppercase tracking-wide text-text-muted">
          <Icon name="check_circle" size={13} />
          Resolved
        </div>
      )}

      {discussion.documentContent && (
        <p className="mb-2 line-clamp-2 border-l-2 border-status-warning/70 bg-status-warning/5 px-2 py-1 font-ui-xs text-ui-xs italic text-text-secondary">
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

      {/* AI edit approve/reject bar */}
      {isAiEditing && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-primary-container/30 bg-primary-container/5 px-3 py-2">
          {!aiStreamDone ? (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-primary-container border-t-transparent" />
              <span className="font-ui-xs text-ui-xs font-medium">AI is editing…</span>
            </div>
          ) : (
            <>
              <span className="font-ui-xs text-ui-xs font-medium text-text-secondary">AI edit ready</span>
              <div className="ml-auto flex gap-1.5">
                <button
                  onClick={onAiApprove}
                  className="flex items-center gap-1 rounded-md bg-insertion-bg px-2.5 py-1 font-ui-xs text-ui-xs font-semibold text-insertion-text transition-colors hover:bg-insertion-bg/80"
                >
                  <Icon name="check" size={14} />
                  Approve
                </button>
                <button
                  onClick={onAiReject}
                  className="flex items-center gap-1 rounded-md bg-deletion-bg px-2.5 py-1 font-ui-xs text-ui-xs font-semibold text-deletion-text transition-colors hover:bg-deletion-bg/80"
                >
                  <Icon name="close" size={14} />
                  Reject
                </button>
              </div>
            </>
          )}
        </div>
      )}

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
        {!discussion.isResolved && !isAiEditing && (
          <button
            onClick={() => onAiEdit(discussion)}
            title="Apply this comment as an AI edit to the commented text"
            className="flex items-center gap-1 rounded-md px-2 py-1 font-ui-xs text-ui-xs font-semibold text-primary-container transition-colors hover:bg-accent-bg"
          >
            <Icon name="auto_awesome" size={15} />
            AI edit
          </button>
        )}
      </div>

      {!discussion.isResolved && caps.canComment && (
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
  const [aiEditingId, setAiEditingId] = React.useState<string | null>(null);

  // Track AI streaming status to know when the edit is done.
  const aiChat = usePluginOption(AIChatPlugin, "chat") as { status: string };
  const aiStreamDone = aiEditingId !== null && aiChat.status === "ready";

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

  // Select the commented range, then run an AI edit driven by the comment text.
  // The AI menu opens with the instruction pre-filled; the user reviews + accepts.
  const aiEdit = React.useCallback(
    (d: TDiscussion) => {
      const key = getCommentKey(d.id);
      const entries = [
        ...editor.api.nodes({
          at: [],
          match: (n) => !!(n as Record<string, unknown>)[key],
        }),
      ];
      if (entries.length === 0) {
        toast.error("Couldn't locate the commented text in the document.");
        return;
      }
      const startPath = entries[0][1];
      const endPath = entries[entries.length - 1][1];
      const range = {
        anchor: editor.api.start(startPath)!,
        focus: editor.api.end(endPath)!,
      };
      editor.tf.focus();
      editor.tf.select(range);

      const instruction =
        richText(d.comments[0]?.contentRich as RichNode[]) ||
        "Improve this text.";
      const ai = editor.getApi(AIChatPlugin).aiChat;
      // Submit silently — no ai.show() — because we handle Approve/Reject
      // right here in the comments panel. Opening the AI menu and then calling
      // aiChat.hide() on approve causes the plugin to undo the accepted edits.
      void ai.submit("", {
        toolName: "edit",
        prompt: `Revise the selected text to address this reviewer comment: "${instruction}". Preserve the author's intent and only change what the comment asks for.`,
      });
      setAiEditingId(d.id);
      toast.success("Asking AI to apply the comment…");
    },
    [editor],
  );

  const handleAiApprove = React.useCallback(() => {
    stampPendingAiEdits(editor);
    acceptAISuggestions(editor);
    // Do NOT call aiChat.hide() — the menu was never shown (we submit silently),
    // and calling hide() triggers internal AI plugin cleanup that reverts the
    // accepted suggestions. Just refocus the editor after finalizing.
    editor.tf.focus({ edge: 'end' });
    setAiEditingId(null);
    toast.success("AI edit approved.");
  }, [editor]);

  const handleAiReject = React.useCallback(() => {
    rejectAISuggestions(editor);
    // No aiChat.hide() needed — menu was never shown.
    editor.tf.focus();
    setAiEditingId(null);
    toast.info("AI edit rejected.");
  }, [editor]);

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
              onAiEdit={aiEdit}
              isAiEditing={aiEditingId === d.id}
              aiStreamDone={aiEditingId === d.id && aiStreamDone}
              onAiApprove={handleAiApprove}
              onAiReject={handleAiReject}
            />
          ))
        )}
      </div>
    </aside>
  );
}
