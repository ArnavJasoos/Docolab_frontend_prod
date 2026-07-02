// =============================================================================
// lib/api/versions.ts  —  REAL backend integration (was a localStorage stub).
//
// Talks to the FastAPI Versioning & Approval cluster via apiFetch (./client),
// which adds the base URL + Bearer token. Backend routes (canonical):
//   GET  /documents/:id/versions
//   POST /documents/:id/submit-for-approval   (content = frozen Slate value)
//   POST /versions/:id/approve | /reject
//
// Version CONTENT (list/save/diff/restore) lives in lib/api/snapshots.ts.
// =============================================================================

import type { Value } from "platejs";

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
    // Author id only here — display surfaces resolve names via the org roster
    // (see lib/api/snapshots.ts, which the version-history UI uses).
    authorName: v.created_by,
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
 * Submit the live document for owner approval (freezes a warm submission).
 * Maps to POST /documents/:id/submit-for-approval. Pass the editor's live
 * content so the frozen submission is diffable in version history.
 */
export async function submitForApproval(
  docId: string,
  content?: Value,
): Promise<{ versionId: string; versionNo: number; message: string }> {
  const res = await apiFetch<{ version_id: string; version_no: number; message: string }>(
    `/documents/${docId}/submit-for-approval`,
    { method: "POST", body: JSON.stringify({ content: content ?? null }) },
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

// NOTE: whole-version restore is now done client-side: the version dialog
// loads the frozen content (lib/api/snapshots.ts::getSnapshot) and applies it
// to the live editor, so the change propagates through Yjs to every client
// and persists via the collab server — no REST restore round-trip needed.
