"use client";

import * as React from "react";
import Link from "next/link";

import { Icon } from "@/components/icon";
import { DocMenubar } from "@/components/editor/doc-menubar";
import { DocTitle, SaveStatus } from "@/components/editor/doc-title";
import { PresenceStack } from "@/components/editor/presence-stack";
import { DocOverflowMenu } from "@/components/editor/doc-overflow-menu";
import { ShareDialog } from "@/components/editor/share-dialog";
import { VersionHistoryDialog } from "@/components/editor/version-history-dialog";
import { cn } from "@/lib/utils";
import { useDocument } from "@/lib/store/document-store";

export function EditorTopBar() {
  const {
    docId,
    title,
    commentsOpen,
    toggleComments,
    shareOpen,
    setShareOpen,
    versionsOpen,
    setVersionsOpen,
  } = useDocument();

  return (
    <header className="z-50 flex h-14 w-full shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-lg text-primary">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href="/browser"
          aria-label="Back to documents"
          className="flex shrink-0 items-center gap-1.5 font-display-sm text-display-sm font-bold text-primary"
        >
          <Icon name="description" fill className="text-[26px]" />
        </Link>
        <div className="hidden md:block">
          <DocMenubar />
        </div>
        <div className="mx-1 hidden h-5 w-px shrink-0 bg-border-subtle sm:block" />
        <div className="flex min-w-0 flex-col">
          <DocTitle />
          <div className="px-1.5">
            <SaveStatus />
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
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

      <ShareDialog
        docId={docId}
        docTitle={title}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <VersionHistoryDialog
        docId={docId}
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
      />
    </header>
  );
}
