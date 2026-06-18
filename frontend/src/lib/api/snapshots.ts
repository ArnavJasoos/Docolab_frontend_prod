// =============================================================================
// lib/api/snapshots.ts  —  Local version-content store (demo-grade).
//
// The backend stores version *metadata* only (s3_key) and GET /versions/:id is
// a stub, so it cannot return the actual document content needed to diff two
// versions. This local store keeps the full Plate `Value` per saved version so
// the "Compare documents" feature has real content to diff. Same swappable
// localStorage seam as documents.ts / comments.ts.
// =============================================================================

import type { Value } from "platejs";

import { latency, read, uid, write } from "@/lib/api/db";

export interface DocSnapshot {
  id: string;
  docId: string;
  versionNo: number;
  label: string;
  kind: "submission" | "approved";
  authorId: string;
  authorName: string;
  createdAt: string;
  /** Full editor content captured at save time. */
  value: Value;
}

const keyFor = (docId: string) => `snapshots:${docId}`;
const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Seed: three progressively-edited versions of the "project-nexus" demo doc so
// the compare view shows meaningful inserts (green) and deletions (red).
// ---------------------------------------------------------------------------

const nexusV1: Value = [
  { type: "h1", children: [{ text: "Project Nexus: Strategic Initiative Q3" }] },
  { type: "h2", children: [{ text: "1. Executive Summary" }] },
  {
    type: "p",
    children: [
      {
        text: "Current market conditions require a change in how we approach enterprise collaboration. Project Nexus aims to connect structured documentation with real-time communication. We project a 18% increase in team velocity.",
      },
    ],
  },
  { type: "h2", children: [{ text: "1.1 Problem Statement" }] },
  {
    type: "p",
    children: [
      { text: "Data silos exist across departments. The marketing team uses " },
      { text: "System Alpha", bold: true },
      { text: ", while engineering uses System Gamma." },
    ],
  },
  { type: "h3", children: [{ text: "Key Objectives" }] },
  { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "Eliminate redundant data entry across systems." }] },
  { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "Establish a single source of truth for product specifications." }] },
];

const nexusV2: Value = [
  { type: "h1", children: [{ text: "Project Nexus: Strategic Initiative Q3" }] },
  { type: "h2", children: [{ text: "1. Executive Summary" }] },
  {
    type: "p",
    children: [
      {
        text: "The current market conditions necessitate a paradigm shift in how we approach enterprise collaboration. Project Nexus aims to bridge the gap between structured documentation and real-time communication. By unifying these paradigms, we project a 22% increase in cross-functional team velocity.",
      },
    ],
  },
  { type: "h2", children: [{ text: "1.1 Problem Statement" }] },
  {
    type: "p",
    children: [
      { text: "Data silos have become entrenched across departments. The marketing team utilizes " },
      { text: "System Alpha", bold: true },
      { text: ", while engineering is heavily invested in System Gamma. This bifurcation leads to outdated specifications being referenced in active sprints." },
    ],
  },
  { type: "h3", children: [{ text: "Key Objectives" }] },
  { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "Eliminate redundant data entry across systems." }] },
  { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "Establish a single source of truth for product specifications." }] },
  { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "Integrate asynchronous review cycles natively." }] },
];

function seedFor(docId: string): DocSnapshot[] {
  if (docId !== "project-nexus") return [];
  return [
    {
      id: "snap-nexus-1",
      docId,
      versionNo: 1,
      label: "Version 1 · Approved",
      kind: "approved",
      authorId: "marcus",
      authorName: "Marcus Reed",
      createdAt: daysAgo(6),
      value: nexusV1,
    },
    {
      id: "snap-nexus-2",
      docId,
      versionNo: 2,
      label: "Version 2 · Approved",
      kind: "approved",
      authorId: "sarah",
      authorName: "Sarah Chen",
      createdAt: daysAgo(2),
      value: nexusV2,
    },
  ];
}

/** List saved version snapshots for a document, newest first. */
export async function getSnapshots(docId: string): Promise<DocSnapshot[]> {
  await latency(120);
  const stored = read<DocSnapshot[] | null>(keyFor(docId), null);
  if (stored) return [...stored].sort((a, b) => b.versionNo - a.versionNo);
  const seed = seedFor(docId);
  write(keyFor(docId), seed);
  return [...seed].sort((a, b) => b.versionNo - a.versionNo);
}

export async function getSnapshot(
  docId: string,
  id: string,
): Promise<DocSnapshot | null> {
  const all = await getSnapshots(docId);
  return all.find((s) => s.id === id) ?? null;
}

/** Capture the current content as a new version snapshot. */
export async function saveSnapshot(
  docId: string,
  value: Value,
  meta: { authorId: string; authorName: string; kind?: "submission" | "approved" },
): Promise<DocSnapshot> {
  const existing = read<DocSnapshot[] | null>(keyFor(docId), null) ?? seedFor(docId);
  const nextNo = existing.reduce((m, s) => Math.max(m, s.versionNo), 0) + 1;
  const snap: DocSnapshot = {
    id: uid("snap"),
    docId,
    versionNo: nextNo,
    label: `Version ${nextNo} · Submission`,
    kind: meta.kind ?? "submission",
    authorId: meta.authorId,
    authorName: meta.authorName,
    createdAt: new Date().toISOString(),
    value,
  };
  write(keyFor(docId), [...existing, snap]);
  return snap;
}
