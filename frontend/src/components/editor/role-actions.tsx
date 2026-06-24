"use client";

import * as React from "react";
import { toast } from "sonner";

import { Icon } from "@/components/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useDocument } from "@/lib/store/document-store";
import type { UiRole } from "@/lib/roles";
import { listVersions, submitForApproval, approveVersion, rejectVersion } from "@/lib/api/versions";
import { createRecommendation } from "@/lib/api/recommendations";

const ROLE_TONE: Record<UiRole, string> = {
  Owner: "bg-insertion-bg text-insertion-text",
  Manager: "bg-accent-bg text-primary-container",
  Collaborator: "bg-status-warning/15 text-status-warning",
  Viewer: "bg-surface-container text-text-secondary",
};

const ROLE_ICON: Record<UiRole, string> = {
  Owner: "shield_person",
  Manager: "verified_user",
  Collaborator: "edit",
  Viewer: "visibility",
};

const ALL_ROLES: UiRole[] = ["Owner", "Manager", "Collaborator", "Viewer"];

// Rank for bounding the preview switcher: you can only preview a role at or
// below your own (downgrade), never above it (which would be client-side
// privilege escalation — the store clamps caps too, this just hides the option).
const UI_RANK: Record<UiRole, number> = {
  Viewer: 0,
  Collaborator: 1,
  Manager: 2,
  Owner: 3,
};

/**
 * Role pill that doubles as a "preview as role" switcher. The switcher is a
 * demo/standalone affordance: with no live backend everyone resolves to Owner,
 * so this lets you see each custom view (and the approval flow) for real.
 */
export function RoleBadge() {
  const { uiRole, realUiRole, previewRole, setPreviewRole } = useDocument();
  if (!uiRole) return null;
  // Only offer roles at or below the user's real role (downgrade-only preview).
  const selectableRoles = realUiRole
    ? ALL_ROLES.filter((r) => UI_RANK[r] <= UI_RANK[realUiRole])
    : [];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Preview as role"
        className={cn(
          "hidden shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-ui-xs text-ui-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-container sm:flex",
          ROLE_TONE[uiRole],
        )}
      >
        <Icon name={ROLE_ICON[uiRole]} size={14} />
        {uiRole}
        <Icon name="expand_more" size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="font-ui-xs text-ui-xs text-text-muted">
          Preview as role
        </DropdownMenuLabel>
        {selectableRoles.map((r) => (
          <DropdownMenuItem key={r} onSelect={() => setPreviewRole(r)}>
            <Icon name={ROLE_ICON[r]} size={16} className="text-text-muted" />
            <span className="flex-1">{r}</span>
            {uiRole === r && <Icon name="check" size={16} />}
          </DropdownMenuItem>
        ))}
        {previewRole && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPreviewRole(null)}>
              <Icon name="undo" size={16} className="text-text-muted" />
              <span className="flex-1">Reset to my role</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Role-specific primary action in the top bar:
 *  - Collaborator (canSubmit, !canApprove): "Submit for review".
 *  - Manager/Owner (canApprove): "Review submission" when one is pending.
 */
export function RoleActions() {
  const { docId, caps } = useDocument();
  const [submitting, setSubmitting] = React.useState(false);
  const [pendingVersionId, setPendingVersionId] = React.useState<string | null>(null);
  const [pendingVersionNo, setPendingVersionNo] = React.useState<number | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);

  const refreshPending = React.useCallback(async () => {
    if (!caps.canApprove) return;
    try {
      const versions = await listVersions(docId);
      const sub = versions.find((v) => v.kind === "submission");
      setPendingVersionId(sub?.id ?? null);
      setPendingVersionNo(sub?.versionNo ?? null);
    } catch {
      /* backend unreachable — no review affordance from this source */
    }
  }, [docId, caps.canApprove]);

  React.useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await submitForApproval(docId);
      toast.success(res.message || `Submitted version ${res.versionNo} for review`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not submit for review");
    } finally {
      setSubmitting(false);
    }
  };

  if (caps.canSubmit && !caps.canApprove) {
    return (
      <button
        onClick={() => void onSubmit()}
        disabled={submitting}
        className="flex items-center gap-1.5 rounded-md bg-primary-container px-3 py-1.5 font-ui-sm text-ui-sm font-semibold text-on-primary shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-60"
      >
        <Icon name="send" size={16} />
        <span className="hidden sm:inline">{submitting ? "Submitting…" : "Submit for review"}</span>
      </button>
    );
  }

  if (caps.canApprove && pendingVersionId) {
    return (
      <>
        <button
          onClick={() => setReviewOpen(true)}
          className="flex items-center gap-1.5 rounded-md bg-status-warning/20 px-3 py-1.5 font-ui-sm text-ui-sm font-semibold text-status-warning shadow-sm transition-colors hover:bg-status-warning/30"
        >
          <Icon name="rate_review" size={16} />
          <span className="hidden sm:inline">Review v{pendingVersionNo}</span>
        </button>
        {reviewOpen && (
          <ApprovalFeedbackDialog
            versionNo={pendingVersionNo ?? 0}
            onClose={() => setReviewOpen(false)}
            onCommit={async (decision, feedback) => {
              if (decision === "approve") await approveVersion(pendingVersionId);
              else await rejectVersion(pendingVersionId);
              if (feedback.trim()) {
                try {
                  await createRecommendation(pendingVersionId, feedback.trim());
                } catch {
                  toast.warning("Decision saved, but feedback could not be attached");
                }
              }
            }}
            onDone={() => {
              setReviewOpen(false);
              void refreshPending();
            }}
          />
        )}
      </>
    );
  }

  return null;
}

/**
 * The mandatory-feedback modal. Per spec, whether the Manager approves OR
 * declines, a feedback box pops up. The caller supplies `onCommit(decision,
 * feedback)` — for the real pending version it runs approve/reject +
 * recommendation; for a local snapshot it mirrors the decision locally.
 */
export function ApprovalFeedbackDialog({
  versionNo,
  onClose,
  onDone,
  onCommit,
}: {
  versionNo: number;
  onClose: () => void;
  onDone: () => void;
  onCommit: (decision: "approve" | "reject", feedback: string) => Promise<void>;
}) {
  const [decision, setDecision] = React.useState<"approve" | "reject" | null>(null);
  const [feedback, setFeedback] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const commit = async () => {
    if (!decision) return;
    setBusy(true);
    try {
      await onCommit(decision, feedback);
      toast.success(
        decision === "approve"
          ? `Version ${versionNo} approved`
          : `Version ${versionNo} declined`,
      );
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record decision");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        style={{
          backgroundColor: "#ffffff",
          width: "min(28rem, calc(100vw - 2rem))",
          maxWidth: "calc(100vw - 2rem)",
        }}
        className="border border-border-subtle p-5 opacity-100 shadow-float"
      >
        <DialogTitle className="mb-3 flex items-center gap-2 font-display-sm text-display-sm font-bold text-text-primary">
          <Icon name="rate_review" className="text-primary-container" />
          Review version {versionNo}
        </DialogTitle>

        <div className="mb-4 flex gap-2">
          <button
            onClick={() => setDecision("approve")}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 font-ui-sm text-ui-sm font-semibold transition-colors",
              decision === "approve"
                ? "border-insertion-text bg-insertion-bg text-insertion-text"
                : "border-border-subtle text-text-secondary hover:bg-surface-container",
            )}
          >
            <Icon name="check_circle" size={18} /> Approve
          </button>
          <button
            onClick={() => setDecision("reject")}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 font-ui-sm text-ui-sm font-semibold transition-colors",
              decision === "reject"
                ? "border-status-error bg-status-error/10 text-status-error"
                : "border-border-subtle text-text-secondary hover:bg-surface-container",
            )}
          >
            <Icon name="cancel" size={18} /> Decline
          </button>
        </div>

        <label className="mb-1 block font-ui-xs text-ui-xs font-semibold text-text-secondary">
          Feedback to the team {decision === "reject" && <span className="text-status-error">(recommended)</span>}
        </label>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={4}
          placeholder="Describe what to change or why this is approved…"
          className="mb-4 w-full resize-none rounded-md border border-border-subtle bg-surface-container-low p-2.5 font-ui-sm text-ui-sm text-text-primary focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 font-ui-sm text-ui-sm font-semibold text-text-secondary hover:bg-surface-container"
          >
            Cancel
          </button>
          <button
            onClick={() => void commit()}
            disabled={!decision || busy}
            className="rounded-md bg-primary-container px-4 py-1.5 font-ui-sm text-ui-sm font-semibold text-on-primary hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Submit decision"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
