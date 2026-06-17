// =============================================================================
// lib/api/versions.ts  —  REAL backend integration (was a localStorage stub).
//
// Talks to the FastAPI Versioning & Approval cluster via apiFetch (./client),
// which adds the base URL + Bearer token. Backend routes (canonical):
//   GET  /documents/:id/versions
//   POST /documents/:id/submit-for-approval
//   POST /versions/:id/restore
//
// NOTE: these calls require a valid auth token in localStorage["docflow.token"].
// Until lib/api/auth.ts is wired to the real backend (to store a real JWT on
// login), the backend will reject these with 401. See INTEGRATION_CHANGES.md.
// =============================================================================

import type { DocVersion } from "@/lib/types";
import { apiFetch } from "@/lib/api/client";

/** Raw row returned by the backend (VersionResponse). */
interface VersionResponse {
  id: string;
  document_id: string;
  version_no: number;
  kind: "submission" | "approved";
  created_by: string;
  created_at: string;
  s3_key: string;
}

function toDocVersion(v: VersionResponse, isCurrent: boolean): DocVersion {
  const kindLabel = v.kind === "approved" ? "Approved" : "Pending review";
  return {
    id: v.id,
    label: `Version ${v.version_no} · ${kindLabel}`,
    createdAt: v.created_at,
    authorId: v.created_by,
    // Backend returns the author id only; resolve to a display name once
    // lib/api/users (GET /api/users) is wired. Shows the id for now.
    authorName: v.created_by === "00000000-0000-0000-0000-0000000000aa" ? "You" : v.created_by,
    isCurrent,
    kind: v.kind,
    versionNo: v.version_no,
  };
}

/** List a document's version history (newest first). */
export async function listVersions(docId: string): Promise<DocVersion[]> {
  const data = await apiFetch<{ versions: VersionResponse[] }>(
    `/documents/${docId}/versions`,
  );
  // Backend orders version_no DESC, so the first row is the latest snapshot.
  return data.versions.map((v, i) => toDocVersion(v, i === 0));
}

/**
 * Snapshot the current doc as a new version.
 *
 * The backend has no generic "snapshot" endpoint — the only way to freeze a
 * version is to submit it for approval (kind="submission"). So this maps to
 * POST /documents/:id/submit-for-approval. `label` is currently ignored by the
 * backend (it derives the label from version_no/kind).
 */
export async function snapshotVersion(
  docId: string,
  label: string,
): Promise<DocVersion> {
  const res = await apiFetch<{ version_id: string; version_no: number; message: string }>(
    `/documents/${docId}/submit-for-approval`,
    { method: "POST", body: "{}" },
  );
  return {
    id: res.version_id,
    label: label || `Version ${res.version_no} · Submission`,
    createdAt: new Date().toISOString(),
    authorId: "you",
    authorName: "You",
    isCurrent: true,
  };
}

/**
 * Submit the live document for owner approval (freezes a warm submission).
 * Maps to POST /documents/:id/submit-for-approval.
 */
export async function submitForApproval(
  docId: string,
): Promise<{ versionId: string; versionNo: number; message: string }> {
  const res = await apiFetch<{ version_id: string; version_no: number; message: string }>(
    `/documents/${docId}/submit-for-approval`,
    { method: "POST", body: "{}" },
  );
  return { versionId: res.version_id, versionNo: res.version_no, message: res.message };
}

/** Owner approves a submission version. The note becomes a recommendation. */
export async function approveVersion(
  versionId: string,
  note?: string,
): Promise<void> {
  await apiFetch(`/versions/${versionId}/approve`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? "" }),
  });
}

/** Owner rejects a submission version with required change notes. */
export async function rejectVersion(
  versionId: string,
  note?: string,
): Promise<void> {
  await apiFetch(`/versions/${versionId}/reject`, {
    method: "POST",
    body: JSON.stringify({ note: note ?? "" }),
  });
}

/**
 * Restore a version.
 *
 * NOTE: the backend POST /versions/:id/restore is section-scoped
 * (RestoreRequest.section_id), whereas the UI calls restoreVersion(docId,
 * versionId) to restore a whole snapshot. We send section_id="full" as a
 * stopgap — reconcile the semantics with the backend (see INTEGRATION_CHANGES).
 */
export async function restoreVersion(
  _docId: string,
  versionId: string,
): Promise<void> {
  await apiFetch(`/versions/${versionId}/restore`, {
    method: "POST",
    body: JSON.stringify({ section_id: "full" }),
  });
}
