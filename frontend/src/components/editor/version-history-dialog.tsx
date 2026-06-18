"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import * as versions from "@/lib/api/versions";
import {
  getSnapshots,
  saveSnapshot,
  type DocSnapshot,
} from "@/lib/api/snapshots";
import * as documentsApi from "@/lib/api/documents";
import * as auth from "@/lib/api/auth";
import { useDocumentOptional } from "@/lib/store/document-store";

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function VersionHistoryDialog({
  docId,
  open,
  onOpenChange,
  onCompare,
}: {
  docId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Open the full-screen compare view for a given saved version vs. current. */
  onCompare: (snapshotId: string) => void;
}) {
  const ctx = useDocumentOptional();

  const [list, setList] = React.useState<DocSnapshot[] | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const load = React.useCallback(() => {
    void getSnapshots(docId).then(setList);
  }, [docId]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setList(null);
    void getSnapshots(docId).then((v) => {
      if (!cancelled) setList(v);
    });
    return () => {
      cancelled = true;
    };
  }, [open, docId]);

  // Capture the current document content as a new version snapshot.
  const saveCurrent = async () => {
    setSaving(true);
    try {
      const current = await documentsApi.getDocument(docId);
      if (!current) throw new Error("missing");
      const me = auth.getCurrentUser();
      await saveSnapshot(docId, current.content, {
        authorId: me?.id ?? "you",
        authorName: me?.name ?? "You",
      });
      toast.success("Saved current version");
      load();
    } catch {
      toast.error("Couldn't save version");
    } finally {
      setSaving(false);
    }
  };

  // Submit for owner approval (governance, best-effort to backend) and also
  // freeze a local snapshot so the demo version list reflects the submission.
  const submit = async () => {
    setSubmitting(true);
    try {
      await versions.submitForApproval(docId).catch(() => undefined);
      const current = await documentsApi.getDocument(docId);
      if (current) {
        const me = auth.getCurrentUser();
        await saveSnapshot(docId, current.content, {
          authorId: me?.id ?? "you",
          authorName: me?.name ?? "You",
          kind: "submission",
        });
      }
      toast.success("Submitted for approval");
      ctx?.setStatus("Pending Review");
      load();
    } catch {
      toast.error("Couldn't submit for approval");
    } finally {
      setSubmitting(false);
    }
  };

  // Restore a snapshot as the current content, then reload to re-mount the editor.
  const restore = async (snap: DocSnapshot) => {
    setRestoring(snap.id);
    try {
      await documentsApi.updateDocument(docId, { content: snap.value });
      toast.success(`Restored ${snap.label}`);
      if (typeof window !== "undefined") window.location.reload();
    } catch {
      toast.error("Couldn't restore version");
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        style={{ backgroundColor: "#ffffff", width: "min(30rem, calc(100vw - 2rem))", maxWidth: "calc(100vw - 2rem)" }}
        className="flex flex-col gap-0 border border-border-subtle p-0 opacity-100 shadow-float"
      >
        <button
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 flex size-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-container hover:text-text-primary"
        >
          <Icon name="close" size={18} />
        </button>
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="font-ui-lg text-ui-lg">Version history</DialogTitle>
          <DialogDescription className="font-ui-sm text-ui-sm">
            Save a version, restore an earlier snapshot, or compare any version
            against the current document.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 px-6 pb-3">
          <button
            onClick={() => void saveCurrent()}
            disabled={saving}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 font-ui-sm text-ui-sm font-semibold text-text-primary transition-colors hover:bg-surface-container disabled:opacity-60"
          >
            <Icon name="bookmark_add" size={16} />
            {saving ? "Saving…" : "Save version"}
          </button>
          <button
            onClick={() => void submit()}
            disabled={submitting}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary-container px-4 py-2 font-ui-sm text-ui-sm font-semibold text-on-primary transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            <Icon name="send" size={16} />
            {submitting ? "Submitting…" : "Submit for approval"}
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto px-3 pb-3">
          {/* Current (live) row */}
          <div className="rounded-lg bg-accent-bg px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-container/15 text-primary-container">
                <Icon name="edit_document" size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-ui-sm text-ui-sm font-medium text-text-primary">
                  Current version
                </p>
                <p className="truncate font-ui-xs text-ui-xs text-text-muted">
                  Live document
                </p>
              </div>
              <span className="rounded-full bg-primary-container/10 px-2 py-0.5 font-ui-xs text-ui-xs font-semibold text-primary-container">
                Current
              </span>
            </div>
          </div>

          {!list &&
            [0, 1].map((i) => (
              <div key={i} className="m-1 h-12 animate-pulse rounded bg-surface-container" />
            ))}
          {list?.length === 0 && (
            <p className="px-3 py-6 text-center font-ui-sm text-ui-sm text-text-muted">
              No saved versions yet. Use “Save version” to create one.
            </p>
          )}
          {list?.map((v) => (
            <div
              key={v.id}
              className="rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-container-low"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-container text-text-secondary">
                  <Icon name="history" size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-ui-sm text-ui-sm font-medium text-text-primary">
                    {v.label}
                  </p>
                  <p className="truncate font-ui-xs text-ui-xs text-text-muted">
                    {v.authorName} · {when(v.createdAt)}
                  </p>
                </div>
                <button
                  onClick={() => onCompare(v.id)}
                  className="flex items-center gap-1 rounded-md px-2.5 py-1 font-ui-xs text-ui-xs font-semibold text-primary-container transition-colors hover:bg-accent-bg"
                >
                  <Icon name="difference" size={14} />
                  Compare
                </button>
                <button
                  onClick={() => void restore(v)}
                  disabled={restoring === v.id}
                  className="rounded-md px-2.5 py-1 font-ui-xs text-ui-xs font-semibold text-text-secondary transition-colors hover:bg-surface-container disabled:opacity-60"
                >
                  {restoring === v.id ? "Restoring…" : "Restore"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
