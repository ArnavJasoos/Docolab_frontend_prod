"use client";

import * as React from "react";
import { toast } from "sonner";

import type { DocVersion } from "@/lib/types";
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
}: {
  docId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const ctx = useDocumentOptional();
  const isOwner = ctx?.doc?.ownerId === "you";

  const [list, setList] = React.useState<DocVersion[] | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  // Per-version review note keyed by version id, plus which row is expanded.
  const [reviewFor, setReviewFor] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");

  const load = React.useCallback(() => {
    void versions.listVersions(docId).then(setList);
  }, [docId]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setList(null);
      try {
        const v = await versions.listVersions(docId);
        if (!cancelled) setList(v);
      } catch {
        if (!cancelled) setList([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, docId]);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await versions.submitForApproval(docId);
      toast.success(res.message || "Submitted for approval");
      ctx?.setStatus("Pending Review");
      load();
    } catch {
      toast.error("Couldn't submit for approval");
    } finally {
      setSubmitting(false);
    }
  };

  const decide = async (v: DocVersion, action: "approve" | "reject") => {
    if (action === "reject" && !note.trim()) {
      toast.error("Add a note describing the required changes.");
      return;
    }
    setBusy(v.id);
    try {
      if (action === "approve") {
        await versions.approveVersion(v.id, note.trim());
        toast.success(`Approved ${v.label}`);
        ctx?.setStatus("Approved");
      } else {
        await versions.rejectVersion(v.id, note.trim());
        toast.success("Sent back with change requests");
        ctx?.setStatus("Working");
      }
      setReviewFor(null);
      setNote("");
      load();
    } catch {
      toast.error("Action failed");
    } finally {
      setBusy(null);
    }
  };

  const restore = async (id: string) => {
    setRestoring(id);
    try {
      await versions.restoreVersion(docId, id);
      toast.success("Version restored");
      load();
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
        style={{ backgroundColor: "#ffffff", width: "min(28rem, calc(100vw - 2rem))", maxWidth: "calc(100vw - 2rem)" }}
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
            {isOwner
              ? "Review submissions, approve or request changes, or restore an earlier snapshot."
              : "Submit this document for the owner's approval or restore an earlier snapshot."}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-3">
          <button
            onClick={() => void submit()}
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary-container px-4 py-2 font-ui-sm text-ui-sm font-semibold text-on-primary transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            <Icon name="send" size={16} />
            {submitting ? "Submitting…" : "Submit current version for approval"}
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto px-3 pb-3">
          {!list &&
            [0, 1, 2].map((i) => (
              <div key={i} className="m-1 h-12 animate-pulse rounded bg-surface-container" />
            ))}
          {list?.length === 0 && (
            <p className="px-3 py-6 text-center font-ui-sm text-ui-sm text-text-muted">
              No versions yet.
            </p>
          )}
          {list?.map((v) => {
            const pending = v.kind === "submission";
            return (
              <div
                key={v.id}
                className={cn(
                  "rounded-lg px-3 py-2.5",
                  v.isCurrent ? "bg-accent-bg" : "hover:bg-surface-container-low",
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full",
                      pending
                        ? "bg-status-warning/15 text-status-warning"
                        : "bg-surface-container text-text-secondary",
                    )}
                  >
                    <Icon name={pending ? "pending" : "history"} size={18} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-ui-sm text-ui-sm font-medium text-text-primary">
                      {v.label}
                    </p>
                    <p className="truncate font-ui-xs text-ui-xs text-text-muted">
                      {v.authorName} · {when(v.createdAt)}
                    </p>
                  </div>
                  {pending && isOwner ? (
                    <button
                      onClick={() => {
                        setReviewFor(reviewFor === v.id ? null : v.id);
                        setNote("");
                      }}
                      className="rounded-md bg-primary-container px-2.5 py-1 font-ui-xs text-ui-xs font-semibold text-on-primary hover:bg-accent-hover"
                    >
                      Review
                    </button>
                  ) : v.isCurrent ? (
                    <span className="rounded-full bg-primary-container/10 px-2 py-0.5 font-ui-xs text-ui-xs font-semibold text-primary-container">
                      Current
                    </span>
                  ) : (
                    <button
                      onClick={() => void restore(v.id)}
                      disabled={restoring === v.id}
                      className="rounded-md px-2.5 py-1 font-ui-xs text-ui-xs font-semibold text-primary-container transition-colors hover:bg-surface-container disabled:opacity-60"
                    >
                      {restoring === v.id ? "Restoring…" : "Restore"}
                    </button>
                  )}
                </div>

                {/* Owner approval panel */}
                {reviewFor === v.id && isOwner && (
                  <div className="mt-2.5 rounded-lg border border-border-subtle bg-surface-container-lowest p-2.5">
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Notes / required changes (required to request changes)…"
                      rows={3}
                      className="w-full resize-none rounded-md bg-transparent font-ui-sm text-ui-sm text-text-primary outline-none placeholder:text-text-muted"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        onClick={() => void decide(v, "reject")}
                        disabled={busy === v.id}
                        className="rounded-md border border-border-subtle px-3 py-1.5 font-ui-xs text-ui-xs font-semibold text-deletion-text hover:bg-deletion-bg disabled:opacity-60"
                      >
                        Request changes
                      </button>
                      <button
                        onClick={() => void decide(v, "approve")}
                        disabled={busy === v.id}
                        className="rounded-md bg-insertion-text px-3 py-1.5 font-ui-xs text-ui-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        {busy === v.id ? "Working…" : "Approve"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
