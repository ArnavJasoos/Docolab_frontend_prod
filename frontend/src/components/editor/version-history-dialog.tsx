"use client";

import * as React from "react";
import { toast } from "sonner";
import { useEditorRef } from "platejs/react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/icon";
import * as versions from "@/lib/api/versions";
import {
  getSnapshot,
  getSnapshots,
  saveSnapshot,
  type DocSnapshot,
} from "@/lib/api/snapshots";
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
  // The dialog renders inside <Plate>, so this is the LIVE (Yjs-canonical)
  // editor — the only truthful source of current content. The REST document
  // body is intentionally blank (content is collab-owned).
  const editor = useEditorRef();
  const canSubmit = ctx?.caps?.canSubmit ?? false;
  const canEdit = ctx?.caps?.canEdit ?? false;

  const [list, setList] = React.useState<DocSnapshot[] | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const load = React.useCallback(() => {
    void getSnapshots(docId).then(setList);
  }, [docId]);

  // The dialog is conditionally mounted by its parent (open ⇒ fresh state), so
  // `list` starts at null (skeleton) on every open — no reset needed here.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getSnapshots(docId).then((v) => {
      if (!cancelled) setList(v);
    });
    return () => {
      cancelled = true;
    };
  }, [open, docId]);

  // Capture the live editor content as a new backend version (kind=snapshot).
  const saveCurrent = async () => {
    setSaving(true);
    try {
      await saveSnapshot(docId, structuredClone(editor.children));
      toast.success("Saved current version");
      load();
    } catch {
      toast.error("Couldn't save version");
    } finally {
      setSaving(false);
    }
  };

  // Submit for owner approval — freezes the live content on the submission row.
  const submit = async () => {
    setSubmitting(true);
    try {
      await versions.submitForApproval(docId, structuredClone(editor.children));
      toast.success("Submitted for approval");
      ctx?.setStatus("Pending Review");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't submit for approval");
    } finally {
      setSubmitting(false);
    }
  };

  // Restore a version by applying its frozen content to the LIVE editor: the
  // change flows through Yjs to every connected client and persists via the
  // collab server (no reload, no REST write).
  const restore = async (snap: DocSnapshot) => {
    setRestoring(snap.id);
    try {
      const full = snap.value ? snap : await getSnapshot(docId, snap.id);
      if (!full?.value) {
        toast.error("This version has no stored content to restore.");
        return;
      }
      editor.tf.setValue(structuredClone(full.value));
      toast.success(`Restored ${snap.label}`);
      onOpenChange(false);
    } catch {
      toast.error("Couldn't restore version");
    } finally {
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

        {(canEdit || canSubmit) && (
          <div className="flex gap-2 px-6 pb-3">
            {canEdit && (
              <button
                onClick={() => void saveCurrent()}
                disabled={saving}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle px-4 py-2 font-ui-sm text-ui-sm font-semibold text-text-primary transition-colors hover:bg-surface-container disabled:opacity-60"
              >
                <Icon name="bookmark_add" size={16} />
                {saving ? "Saving…" : "Save version"}
              </button>
            )}
            {canSubmit && (
              <button
                onClick={() => void submit()}
                disabled={submitting}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary-container px-4 py-2 font-ui-sm text-ui-sm font-semibold text-on-primary transition-colors hover:bg-accent-hover disabled:opacity-60"
              >
                <Icon name="send" size={16} />
                {submitting ? "Submitting…" : "Submit for approval"}
              </button>
            )}
          </div>
        )}

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
                {canEdit && (
                  <button
                    onClick={() => void restore(v)}
                    disabled={restoring === v.id}
                    className="rounded-md px-2.5 py-1 font-ui-xs text-ui-xs font-semibold text-text-secondary transition-colors hover:bg-surface-container disabled:opacity-60"
                  >
                    {restoring === v.id ? "Restoring…" : "Restore"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
