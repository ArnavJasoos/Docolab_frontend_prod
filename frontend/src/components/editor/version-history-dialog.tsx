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
  const [list, setList] = React.useState<DocVersion[] | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    void versions.listVersions(docId).then(setList);
  }, [docId]);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setList(null);
      const v = await versions.listVersions(docId);
      if (!cancelled) setList(v);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, docId]);

  const restore = async (id: string) => {
    setRestoring(id);
    try {
      await versions.restoreVersion(docId, id);
      toast.success("Version restored");
      load();
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="font-ui-lg text-ui-lg">Version history</DialogTitle>
          <DialogDescription className="font-ui-sm text-ui-sm">
            Restore an earlier snapshot of this document.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 overflow-y-auto px-3 pb-3">
          {!list &&
            [0, 1, 2].map((i) => (
              <div key={i} className="m-1 h-12 animate-pulse rounded bg-surface-container" />
            ))}
          {list?.map((v) => (
            <div
              key={v.id}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5",
                v.isCurrent ? "bg-accent-bg" : "hover:bg-surface-container-low",
              )}
            >
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
              {v.isCurrent ? (
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
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
