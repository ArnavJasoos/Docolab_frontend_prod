// =============================================================================
// lib/api/snapshots.ts — version-content store, backed by the REAL backend.
//
//   GET  /documents/{id}/versions   list version rows (metadata, no content)
//   GET  /versions/{id}             one version incl. its frozen Slate content
//   POST /documents/{id}/versions   freeze the current content (kind=snapshot)
//
// Replaces the old localStorage store (which was per-browser, seeded with demo
// data, and invisible to collaborators). Version content now lives on the
// backend `versions.content` JSONB column, so history/diff/restore work for
// every user on every device.
// =============================================================================

import type { Value } from "platejs";

import { apiFetch } from "@/lib/api/client";
import * as assignments from "@/lib/api/assignments";

export interface DocSnapshot {
  id: string;
  docId: string;
  versionNo: number;
  label: string;
  kind: "submission" | "approved" | "rejected" | "snapshot";
  authorId: string;
  authorName: string;
  createdAt: string;
  /** Full editor content captured at save time (null on legacy rows). */
  value: Value | null;
}

interface VersionRow {
  id: string;
  document_id: string;
  version_no: number;
  kind: DocSnapshot["kind"];
  created_by: string;
  created_at: string;
  content?: Value | null;
}

const KIND_LABEL: Record<DocSnapshot["kind"], string> = {
  approved: "Approved",
  submission: "Pending review",
  rejected: "Rejected",
  snapshot: "Snapshot",
};

function toSnapshot(v: VersionRow, names: Map<string, string>): DocSnapshot {
  return {
    id: v.id,
    docId: v.document_id,
    versionNo: v.version_no,
    label: `Version ${v.version_no} · ${KIND_LABEL[v.kind] ?? v.kind}`,
    kind: v.kind,
    authorId: v.created_by,
    authorName: names.get(v.created_by) ?? "Unknown",
    createdAt: v.created_at,
    value: v.content ?? null,
  };
}

/** Best-effort id → display-name map from the org roster. */
async function authorNames(): Promise<Map<string, string>> {
  try {
    const users = await assignments.listOrgUsers();
    return new Map(users.map((u) => [u.id, u.display_name]));
  } catch {
    return new Map();
  }
}

/** List saved version snapshots for a document, newest first (metadata only —
 *  fetch content per version via getSnapshot when diffing/restoring). */
export async function getSnapshots(docId: string): Promise<DocSnapshot[]> {
  const [data, names] = await Promise.all([
    apiFetch<{ versions: VersionRow[] }>(`/documents/${docId}/versions`),
    authorNames(),
  ]);
  return data.versions
    .map((v) => toSnapshot(v, names))
    .sort((a, b) => b.versionNo - a.versionNo);
}

/** Fetch one version INCLUDING its frozen content. */
export async function getSnapshot(
  docId: string,
  id: string,
): Promise<DocSnapshot | null> {
  void docId; // the id is globally unique; kept for call-site compatibility
  try {
    const [v, names] = await Promise.all([
      apiFetch<VersionRow & { content: Value | null }>(`/versions/${id}`),
      authorNames(),
    ]);
    return toSnapshot(v, names);
  } catch {
    return null;
  }
}

/** Freeze the current content as a new version (kind='snapshot'). */
export async function saveSnapshot(
  docId: string,
  value: Value,
): Promise<DocSnapshot> {
  const v = await apiFetch<VersionRow>(`/documents/${docId}/versions`, {
    method: "POST",
    body: JSON.stringify({ content: value }),
  });
  const names = await authorNames();
  return toSnapshot(v, names);
}
