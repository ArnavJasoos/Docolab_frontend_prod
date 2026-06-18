import type { Value } from "platejs";

import type {
  DocFilter,
  DocSummary,
  DocumentRecord,
  SortKey,
} from "@/lib/types";
import { latency, read, uid, write } from "@/lib/api/db";
import { CURRENT_USER, SEED_DOCS } from "@/lib/api/seed";
import { apiFetch } from "@/lib/api/client";

const KEY = "docs";

/** A genuinely blank document body — a single empty paragraph. */
function blankContent(): Value {
  return [{ type: "p", children: [{ text: "" }] }];
}

/**
 * Best-effort backend exposure of a new document.
 * Maps to POST /documents (FastAPI). Non-blocking: the localStorage record is
 * the source of truth in this mock layer, so a 401 (no auth) or offline backend
 * never blocks creation. Swap localStorage for this response once auth is wired.
 */
async function createDocumentRemote(doc: DocumentRecord): Promise<void> {
  try {
    await apiFetch("/documents", {
      method: "POST",
      body: JSON.stringify({ title: doc.title, folder_id: null }),
    });
  } catch {
    /* backend not reachable / unauthenticated — stay local-only for now */
  }
}

function loadAll(): DocumentRecord[] {
  const existing = read<DocumentRecord[] | null>(KEY, null);
  if (existing && existing.length) return existing;
  write(KEY, SEED_DOCS);
  return SEED_DOCS;
}

function persistAll(docs: DocumentRecord[]): void {
  write(KEY, docs);
}

function toSummary(doc: DocumentRecord): DocSummary {
  // Strip heavy content for list views.
  const { content: _content, ...summary } = doc;
  void _content;
  return summary;
}

function relativeLabel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now by You";
  if (min < 60) return `${min}m ago by You`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago by You`;
  const day = Math.round(hr / 24);
  return day === 1 ? "yesterday" : `${day}d ago by You`;
}

const STATUS_ORDER: Record<string, number> = {
  Working: 0,
  "Pending Review": 1,
  Approved: 2,
  Draft: 3,
};

export async function listDocuments(opts?: {
  filter?: DocFilter;
  sort?: SortKey;
  query?: string;
}): Promise<DocSummary[]> {
  await latency(120);
  const { filter = "all", sort = "updated", query = "" } = opts ?? {};
  let docs = loadAll();

  docs = docs.filter((d) => {
    if (filter === "trash") return d.trashed;
    if (d.trashed) return false;
    if (filter === "starred") return d.starred;
    if (filter === "shared") return d.ownerId !== CURRENT_USER.id;
    return true;
  });

  const q = query.trim().toLowerCase();
  if (q) docs = docs.filter((d) => d.title.toLowerCase().includes(q));

  docs = [...docs].sort((a, b) => {
    if (sort === "title") return a.title.localeCompare(b.title);
    if (sort === "status")
      return (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  if (filter === "recent") docs = docs.slice(0, 6);

  return docs.map(toSummary);
}

export async function getDocument(id: string): Promise<DocumentRecord | null> {
  await latency();
  return loadAll().find((d) => d.id === id) ?? null;
}

export async function createDocument(title = "Untitled document"): Promise<DocumentRecord> {
  await latency();
  const docs = loadAll();
  const doc: DocumentRecord = {
    id: uid("doc"),
    title,
    status: "Draft",
    version: "v0.1",
    updatedAt: new Date().toISOString(),
    updatedLabel: "just now by You",
    ownerId: CURRENT_USER.id,
    starred: false,
    trashed: false,
    collaboratorCount: 1,
    content: blankContent(),
  };
  persistAll([doc, ...docs]);
  // Expose the creation to the backend (best-effort; see note above).
  void createDocumentRemote(doc);
  return doc;
}

export async function updateDocument(
  id: string,
  patch: { title?: string; content?: Value; status?: DocumentRecord["status"] },
): Promise<DocSummary> {
  await latency(160);
  const docs = loadAll();
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) throw new Error(`Document ${id} not found`);
  const updated: DocumentRecord = {
    ...docs[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedLabel: relativeLabel(new Date().toISOString()),
  };
  docs[idx] = updated;
  persistAll(docs);
  return toSummary(updated);
}

export async function duplicateDocument(id: string): Promise<DocumentRecord> {
  await latency();
  const docs = loadAll();
  const src = docs.find((d) => d.id === id);
  if (!src) throw new Error(`Document ${id} not found`);
  const copy: DocumentRecord = {
    ...src,
    id: uid("doc"),
    title: `${src.title} (copy)`,
    ownerId: CURRENT_USER.id,
    starred: false,
    trashed: false,
    updatedAt: new Date().toISOString(),
    updatedLabel: "just now by You",
  };
  persistAll([copy, ...docs]);
  return copy;
}

export async function setTrashed(id: string, trashed: boolean): Promise<void> {
  await latency(140);
  const docs = loadAll();
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) return;
  docs[idx] = { ...docs[idx], trashed };
  persistAll(docs);
}

export async function toggleStar(id: string): Promise<boolean> {
  await latency(80);
  const docs = loadAll();
  const idx = docs.findIndex((d) => d.id === id);
  if (idx === -1) return false;
  const starred = !docs[idx].starred;
  docs[idx] = { ...docs[idx], starred };
  persistAll(docs);
  return starred;
}

export async function deleteForever(id: string): Promise<void> {
  await latency();
  persistAll(loadAll().filter((d) => d.id !== id));
}
