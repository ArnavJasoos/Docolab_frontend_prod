"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { useEditorRef } from "platejs/react";

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
import { getSnapshots, type DocSnapshot } from "@/lib/api/snapshots";
import { isBlankValue } from "@/lib/api/seed";

// Loaded on demand: the diff overlay pulls the whole compare/diff UI, which
// has no place in the top bar's initial chunk.
const CompareView = dynamic(
  () => import("@/components/editor/compare-view").then((m) => m.CompareView),
  { ssr: false },
);

type Decision = "approve" | "reject";

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
        title="Your role in this document (click to preview as a lower role)"
        className={cn(
          // Always visible — this is where a user sees THEIR role on the doc.
          "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-ui-xs text-ui-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary-container",
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
  const { docId, caps, status, refreshDoc } = useDocument();
  // RoleActions renders inside <Plate>, so this is the LIVE (Yjs-canonical)
  // editor. Freeze its content on submit so the resulting version is diffable
  // in history — omitting it froze `content: null`, which made every
  // top-bar-submitted version show "nothing to compare".
  const editor = useEditorRef();
  const [submitting, setSubmitting] = React.useState(false);
  const [pendingVersionId, setPendingVersionId] = React.useState<string | null>(null);
  const [pendingVersionNo, setPendingVersionNo] = React.useState<number | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  // Approved version the pending submission is being diffed against. Set →
  // the full-screen compare overlay replaces the review modal.
  const [compareBaseId, setCompareBaseId] = React.useState<string | null>(null);
  // Lifted so text typed in the modal survives the switch to the overlay's
  // floating bar (and back), which are never mounted at the same time.
  const [feedback, setFeedback] = React.useState("");

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

  // Keep the pending-submission state LIVE: a collaborator's submit must make
  // the manager's "Review" button appear without a reload. Re-checks on mount,
  // whenever the (polled) doc status flips, on a slow interval, and on window
  // focus. refreshPending itself no-ops for non-approvers.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state is set inside the callback
    void refreshPending();
    const interval = setInterval(() => void refreshPending(), 15_000);
    const onFocus = () => void refreshPending();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshPending, status]);

  // The one decision path, shared by the review modal and the compare
  // overlay's floating bar so both behave identically.
  const commitDecision = React.useCallback(
    async (decision: Decision, note: string) => {
      if (!pendingVersionId) return;
      if (decision === "approve") await approveVersion(pendingVersionId);
      else await rejectVersion(pendingVersionId);
      if (note.trim()) {
        try {
          await createRecommendation(pendingVersionId, note.trim());
        } catch {
          toast.warning("Decision saved, but feedback could not be attached");
        }
      }
    },
    [pendingVersionId],
  );

  const afterDecision = React.useCallback(() => {
    setReviewOpen(false);
    setCompareBaseId(null);
    setFeedback("");
    void refreshPending();
    // Approve/reject changed the doc's status + version — reflect it in the
    // top bar immediately.
    void refreshDoc();
  }, [refreshPending, refreshDoc]);

  const closeReview = () => {
    setReviewOpen(false);
    setFeedback("");
  };

  const onSubmit = async () => {
    const content = structuredClone(editor.children);
    if (isBlankValue(content)) {
      toast.error("Document is empty — add content before submitting for approval.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitForApproval(docId, content);
      toast.success(res.message || `Submitted version ${res.versionNo} for review`);
      // Reflect the new pending_approval state (status pill + this button)
      // immediately instead of only after a reload.
      await refreshDoc();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not submit for review");
    } finally {
      setSubmitting(false);
    }
  };

  if (caps.canSubmit && !caps.canApprove) {
    // Already submitted and awaiting a decision: show a non-actionable pending
    // marker (re-submitting while pending is a 409 server-side anyway).
    if (status === "Pending Review") {
      return (
        <span className="flex items-center gap-1.5 rounded-md bg-status-warning/15 px-3 py-1.5 font-ui-sm text-ui-sm font-semibold text-status-warning">
          <Icon name="hourglass_top" size={16} />
          <span className="hidden sm:inline">Pending review</span>
        </span>
      );
    }
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
            docId={docId}
            versionNo={pendingVersionNo ?? 0}
            feedback={feedback}
            onFeedbackChange={setFeedback}
            onCompare={(baseVersionId) => {
              setReviewOpen(false);
              setCompareBaseId(baseVersionId);
            }}
            onClose={closeReview}
            onCommit={commitDecision}
            onDone={afterDecision}
          />
        )}
        {compareBaseId && (
          <CompareView
            docId={docId}
            snapshotId={compareBaseId}
            // Both sides are frozen versions here: an approved baseline vs the
            // submission under review. Neither is the live document.
            compareToId={pendingVersionId}
            onClose={() => setCompareBaseId(null)}
            footer={
              <ApprovalReviewBar
                versionNo={pendingVersionNo ?? 0}
                feedback={feedback}
                onFeedbackChange={setFeedback}
                onCommit={commitDecision}
                onDone={afterDecision}
              />
            }
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
  docId,
  versionNo,
  feedback,
  onFeedbackChange,
  onCompare,
  onClose,
  onDone,
  onCommit,
}: {
  docId: string;
  versionNo: number;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  /** Open the diff against a previously approved version. */
  onCompare: (baseVersionId: string) => void;
  onClose: () => void;
  onDone: () => void;
  onCommit: (decision: Decision, feedback: string) => Promise<void>;
}) {
  const [decision, setDecision] = React.useState<Decision | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Only APPROVED versions are offered as a comparison baseline: the point is
  // "what changed since the last thing a Manager signed off on". null = still
  // loading, [] = this doc has never had a version approved.
  const [baselines, setBaselines] = React.useState<DocSnapshot[] | null>(null);
  const [baseId, setBaseId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await getSnapshots(docId);
        if (cancelled) return;
        const approved = all.filter((s) => s.kind === "approved");
        setBaselines(approved);
        // getSnapshots sorts newest-first, so default to the latest approved
        // version — the baseline a reviewer almost always wants.
        setBaseId(approved[0]?.id ?? null);
      } catch {
        if (!cancelled) setBaselines([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const selectedBaseline = baselines?.find((s) => s.id === baseId) ?? null;
  const baselineLabel =
    baselines === null
      ? "Loading versions…"
      : (selectedBaseline?.label ?? "No approved versions yet");

  const commit = async () => {
    if (!decision || !feedback.trim()) return;
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

        <div className="mb-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => baseId && onCompare(baseId)}
              disabled={!baseId}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-border-subtle px-3 py-2 font-ui-sm text-ui-sm font-semibold text-text-secondary transition-colors hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="difference" size={18} /> Compare with:
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={!baseId}
                className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-md border border-border-subtle px-3 py-2 font-ui-sm text-ui-sm text-text-primary outline-none transition-colors hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary-container disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="truncate">{baselineLabel}</span>
                <Icon name="expand_more" size={16} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-64 min-w-56 overflow-y-auto">
                <DropdownMenuLabel className="font-ui-xs text-ui-xs text-text-muted">
                  Approved versions
                </DropdownMenuLabel>
                {baselines?.map((s) => (
                  <DropdownMenuItem key={s.id} onSelect={() => setBaseId(s.id)}>
                    <span className="flex-1 truncate">{s.label}</span>
                    {baseId === s.id && <Icon name="check" size={16} />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {baselines?.length === 0 && (
            <p className="mt-1.5 font-ui-xs text-ui-xs text-text-muted">
              No approved versions yet — nothing to compare against.
            </p>
          )}
        </div>

        <label className="mb-1 block font-ui-xs text-ui-xs font-semibold text-text-secondary">
          Feedback to the team <span className="text-status-error">(required)</span>
        </label>
        <textarea
          value={feedback}
          onChange={(e) => onFeedbackChange(e.target.value)}
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
            disabled={!decision || busy || !feedback.trim()}
            title={
              !decision
                ? "Choose Approve or Decline first"
                : !feedback.trim()
                  ? "Feedback is required"
                  : undefined
            }
            className="rounded-md bg-primary-container px-4 py-1.5 font-ui-sm text-ui-sm font-semibold text-on-primary hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Saving…" : "Submit decision"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The decision surface while the compare overlay is open: a floating bar
 * pinned to the bottom with the feedback box and both decisions inline, so a
 * Manager can act on what they're reading without leaving the diff. Approve /
 * Decline commit immediately (no separate confirm step — the diff above IS the
 * review), then `onDone` tears the overlay down back to the editor.
 */
function ApprovalReviewBar({
  versionNo,
  feedback,
  onFeedbackChange,
  onCommit,
  onDone,
}: {
  versionNo: number;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  onCommit: (decision: Decision, feedback: string) => Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = React.useState<Decision | null>(null);
  // Feedback is mandatory here exactly as it is in the review modal — the bar
  // commits on click with no confirm step, so this is the only gate.
  const missingFeedback = !feedback.trim();

  const act = async (decision: Decision) => {
    if (missingFeedback) return;
    setBusy(decision);
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
      // Only on failure: onDone unmounts this bar, so clearing busy after a
      // success would set state on an unmounted component.
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-3 shadow-float">
      <div className="mb-2 flex items-center gap-1.5 font-ui-xs text-ui-xs font-semibold text-text-secondary">
        <Icon name="rate_review" size={14} className="text-primary-container" />
        Review version {versionNo}
        <span className="text-status-error">· feedback required</span>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={feedback}
          onChange={(e) => onFeedbackChange(e.target.value)}
          rows={2}
          placeholder="Describe what to change or why this is approved…"
          className="min-w-0 flex-1 resize-none rounded-md border border-border-subtle bg-surface-container-low p-2.5 font-ui-sm text-ui-sm text-text-primary focus:border-primary focus:ring-1 focus:ring-primary focus:outline-none"
        />
        <button
          onClick={() => void act("approve")}
          disabled={busy !== null || missingFeedback}
          title={missingFeedback ? "Feedback is required" : undefined}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-insertion-text bg-insertion-bg px-3 py-2 font-ui-sm text-ui-sm font-semibold text-insertion-text transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="check_circle" size={18} />
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          onClick={() => void act("reject")}
          disabled={busy !== null || missingFeedback}
          title={missingFeedback ? "Feedback is required" : undefined}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-status-error bg-status-error/10 px-3 py-2 font-ui-sm text-ui-sm font-semibold text-status-error transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="cancel" size={18} />
          {busy === "reject" ? "Declining…" : "Decline"}
        </button>
      </div>
    </div>
  );
}
