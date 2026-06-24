"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

import { Icon } from "@/components/icon";
import { DocMenubar } from "@/components/editor/doc-menubar";
import { DocTitle, SaveStatus } from "@/components/editor/doc-title";
import { PresenceStack } from "@/components/editor/presence-stack";
import { DocOverflowMenu } from "@/components/editor/doc-overflow-menu";
import { RoleActions, RoleBadge } from "@/components/editor/role-actions";
import { cn } from "@/lib/utils";
import { useDocument } from "@/lib/store/document-store";

// Dialogs are loaded on first open instead of shipping in the editor's initial
// chunk (version history pulls the version API + diff UI; share pulls the
// collaborator/permission UI).
const ShareDialog = dynamic(
  () => import("@/components/editor/share-dialog").then((m) => m.ShareDialog),
  { ssr: false },
);
const VersionHistoryDialog = dynamic(
  () =>
    import("@/components/editor/version-history-dialog").then(
      (m) => m.VersionHistoryDialog,
    ),
  { ssr: false },
);
const CompareView = dynamic(
  () => import("@/components/editor/compare-view").then((m) => m.CompareView),
  { ssr: false },
);

export function EditorTopBar() {
  const {
    docId,
    doc,
    title,
    status,
    commentsOpen,
    toggleComments,
    shareOpen,
    setShareOpen,
    versionsOpen,
    setVersionsOpen,
  } = useDocument();

  // Snapshot id being compared against the current version (full-screen overlay).
  const [compareId, setCompareId] = React.useState<string | null>(null);

  const STATUS_TONE: Record<string, string> = {
    Draft: "bg-surface-container text-text-secondary",
    Working: "bg-accent-bg text-primary-container",
    "Pending Review": "bg-status-warning/15 text-status-warning",
    Approved: "bg-insertion-bg text-insertion-text",
  };

  return (
    <header className="z-50 flex h-14 w-full shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-lg text-primary">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Link
          href="/browser"
          aria-label="Back to documents"
          className="flex shrink-0 items-center gap-1.5 font-display-sm text-display-sm font-bold text-primary"
        >
          <Icon name="description" fill className="text-[26px]" />
        </Link>
        <div className="hidden shrink-0 md:block">
          <DocMenubar />
        </div>
        <div className="mx-1 hidden h-5 w-px shrink-0 bg-border-subtle sm:block" />
        <div className="flex min-w-[180px] flex-1 flex-col">
          <DocTitle />
          <div className="px-1.5">
            <SaveStatus />
          </div>
        </div>

        <button
          onClick={() => setVersionsOpen(true)}
          title="Version history"
          className={cn(
            "ml-1 hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-ui-xs text-ui-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-container lg:flex",
            STATUS_TONE[status] ?? "bg-surface-container text-text-secondary",
          )}
        >
          <Icon name="history" size={14} />
          {doc?.version ?? "v1.0"}
          <span className="opacity-40">·</span>
          {status}
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <RoleBadge />
        <RoleActions />
        <div className="hidden sm:block">
          <PresenceStack docId={docId} onOpenShare={() => setShareOpen(true)} />
        </div>

        <button
          onClick={toggleComments}
          aria-label="Toggle comments"
          aria-pressed={commentsOpen}
          className={cn(
            "flex size-8 items-center justify-center rounded-full transition-colors",
            commentsOpen
              ? "bg-accent-bg text-primary-container"
              : "text-on-surface-variant hover:bg-surface-container",
          )}
        >
          <Icon name="forum" fill={commentsOpen} size={20} />
        </button>

        <button
          onClick={() => setShareOpen(true)}
          className="flex items-center gap-1.5 rounded-md bg-primary-container px-4 py-1.5 font-ui-sm text-ui-sm font-semibold text-on-primary shadow-sm transition-colors hover:bg-accent-hover"
        >
          <Icon name="group_add" size={18} />
          <span className="hidden sm:inline">Share</span>
        </button>

        <DocOverflowMenu />
      </div>

      {shareOpen && (
        <ShareDialog
          docId={docId}
          docTitle={title}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
      {versionsOpen && (
        <VersionHistoryDialog
          docId={docId}
          open={versionsOpen}
          onOpenChange={setVersionsOpen}
          onCompare={(snapshotId) => {
            setVersionsOpen(false);
            setCompareId(snapshotId);
          }}
        />
      )}
      {compareId && (
        <CompareView
          docId={docId}
          snapshotId={compareId}
          onClose={() => setCompareId(null)}
        />
      )}
    </header>
  );
}
