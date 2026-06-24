// =============================================================================
// lib/api/documents.ts — real backend integration (FastAPI /documents cluster).
//
//   POST   /documents            {title, folder_id}     -> DocumentResponse
//   GET    /documents            ?trashed&starred        -> {documents:[…]}
//   GET    /documents/{id}                               -> DocumentResponse
//   PATCH  /documents/{id}       {title?, trashed?}       -> DocumentResponse
//   DELETE /documents/{id}                               -> 204
//   PUT    /documents/{id}/star  /  DELETE …/star         -> StarResponse
//
// Document CONTENT is NOT carried over REST: it is Yjs/Hocuspocus-canonical
// (online-first). getDocument() returns metadata + a blank body; the editor
// hydrates the real content from the Yjs room (or starts blank as the REST
// fallback when the collab server is unreachable). See plate-editor.tsx.
// =============================================================================

import type { Value } from "platejs";

import type {
  DocFilter,
  DocStatus,
  DocSummary,
  DocumentRecord,
  SortKey,
} from "@/lib/types";
import { apiFetch } from "@/lib/api/client";
import { blankContent } from "@/lib/api/seed";
import { getCurrentUser } from "@/lib/api/auth";

// --- backend response shapes -------------------------------------------------
interface BackendDoc {
  id: string;
  folder_id: string | null;
  title: string;
  status: string;
  current_version_no: number;
  yjs_doc_key?: string;
  starred: boolean;
  trashed: boolean;
  created_by: string;
  created_at?: string;
  updated_at?: string;
}

// The list endpoint returns a lighter item without timestamps.
type BackendDocListItem = Pick<
  BackendDoc,
  "id" | "title" | "status" | "current_version_no" | "starred" | "trashed" | "created_by"
>;

// --- adapters (backend -> frontend) ------------------------------------------
function mapStatus(s: string): DocStatus {
  switch (s) {
    case "working":
      return "Working";
    case "pending_approval":
      return "Pending Review";
    case "approved":
      return "Approved";
    case "draft":
      return "Draft";
    default:
      return "Draft";
  }
}

function relativeLabel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "recently";
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? "yesterday" : `${day}d ago`;
}

/**
 * Map a backend document onto the browser summary. `collaboratorCount` is kept
 * in the UI and defaults to 1 (owner); once the backend exposes a per-document
 * member count (assignments), pass it through here — the wiring is ready.
 */
function toSummary(d: BackendDoc | BackendDocListItem, collaboratorCount = 1): DocSummary {
  const full = d as BackendDoc;
  return {
    id: d.id,
    title: d.title,
    status: mapStatus(d.status),
    version: `v${d.current_version_no ?? 0}`,
    updatedAt: full.updated_at ?? "",
    updatedLabel: full.updated_at ? relativeLabel(full.updated_at) : "recently",
    ownerId: d.created_by,
    starred: d.starred,
    trashed: d.trashed,
    collaboratorCount,
  };
}

function toRecord(d: BackendDoc): DocumentRecord {
  // Content is Yjs-canonical; the editor hydrates it from the collab room.
  return { ...toSummary(d), content: blankContent() };
}

const STATUS_ORDER: Record<string, number> = {
  Working: 0,
  "Pending Review": 1,
  Approved: 2,
  Draft: 3,
};

// --- public API --------------------------------------------------------------
export async function listDocuments(opts?: {
  filter?: DocFilter;
  sort?: SortKey;
  query?: string;
}): Promise<DocSummary[]> {
  const { filter = "all", sort = "updated", query = "" } = opts ?? {};

  const params = new URLSearchParams();
  if (filter === "starred") params.set("starred", "true");
  if (filter === "trash") params.set("trashed", "true");
  const qs = params.toString();

  const data = await apiFetch<{ documents: BackendDocListItem[] }>(
    `/documents${qs ? `?${qs}` : ""}`,
  );
  let docs = data.documents.map((d) => toSummary(d));

  // "shared" / "recent" have no dedicated backend filter — derive client-side.
  if (filter === "shared") {
    const me = getCurrentUser()?.id;
    docs = docs.filter((d) => d.ownerId !== me);
  }

  const q = query.trim().toLowerCase();
  if (q) docs = docs.filter((d) => d.title.toLowerCase().includes(q));

  docs = [...docs].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "status")
      return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  if (filter === "recent") docs = docs.slice(0, 6);
  return docs;
}

export async function getDocument(id: string): Promise<DocumentRecord | null> {
  try {
    const d = await apiFetch<BackendDoc>(`/documents/${id}`);
    return toRecord(d);
  } catch {
    return null;
  }
}

export async function createDocument(title = "Untitled document"): Promise<DocumentRecord> {
  const d = await apiFetch<BackendDoc>("/documents", {
    method: "POST",
    body: JSON.stringify({ title, folder_id: null }),
  });
  return toRecord(d);
}

export async function updateDocument(
  id: string,
  patch: { title?: string; content?: Value; status?: DocumentRecord["status"] },
): Promise<DocSummary> {
  // The backend PATCH only accepts title/folder_id/trashed. `content` is owned
  // by Yjs and `status` transitions go through the approval flow, so neither is
  // sent here — only the title is persisted via this call.
  const d = await apiFetch<BackendDoc>(`/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: patch.title }),
  });
  return toSummary(d);
}

export async function duplicateDocument(id: string): Promise<DocumentRecord> {
  // No backend duplicate endpoint — create a new document client-side carrying
  // the source title. (Deep content copy across Yjs rooms is a follow-up.)
  const src = await apiFetch<BackendDoc>(`/documents/${id}`);
  return createDocument(`${src.title} (copy)`);
}

export async function setTrashed(id: string, trashed: boolean): Promise<void> {
  await apiFetch(`/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ trashed }),
  });
}

export async function toggleStar(id: string): Promise<boolean> {
  // The backend star endpoints are idempotent (not toggles), so read the
  // current state first, then flip it.
  const d = await apiFetch<BackendDoc>(`/documents/${id}`);
  const next = !d.starred;
  await apiFetch(`/documents/${id}/star`, { method: next ? "PUT" : "DELETE" });
  return next;
}

export async function deleteForever(id: string): Promise<void> {
  await apiFetch(`/documents/${id}`, { method: "DELETE" });
}
