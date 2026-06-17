// Type definitions for document management, user presence, and collaboration roles
import type { Value } from "platejs";

import type { DocStatus } from "@/lib/data";

export type { DocStatus };

/** Permission a collaborator (or link) holds on a document. */
export type Role = "owner" | "editor" | "commenter" | "viewer";

/** Who can reach a document beyond explicitly-invited people. */
export type GeneralAccess = "restricted" | "anyone";

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  /** Presence colour token suffix, e.g. "violet" -> bg-presence-violet. */
  hue?: PresenceHue;
}

export type PresenceHue =
  | "violet"
  | "fuchsia"
  | "orange"
  | "teal"
  | "rose"
  | "lime"
  | "sky"
  | "amber";

export interface Collaborator {
  user: User;
  role: Role;
}

export interface PresenceUser extends User {
  hue: PresenceHue;
  /** Active = currently in the doc, idle = open but away. */
  state: "active" | "idle";
}

/** Lightweight record used by the document browser. */
export interface DocSummary {
  id: string;
  title: string;
  status: DocStatus;
  version: string;
  /** ISO timestamp of last edit. */
  updatedAt: string;
  /** Human label, e.g. "2h ago by Sarah". */
  updatedLabel: string;
  ownerId: string;
  starred: boolean;
  trashed: boolean;
  collaboratorCount: number;
}

/** Full document including editor content. */
export interface DocumentRecord extends DocSummary {
  content: Value;
}

export interface DocVersion {
  id: string;
  label: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  isCurrent: boolean;
  /** Cold approved baseline vs. a warm submission awaiting owner review. */
  kind?: "submission" | "approved";
  versionNo?: number;
}

export interface ShareState {
  collaborators: Collaborator[];
  generalAccess: GeneralAccess;
  /** Role granted to anyone-with-the-link when generalAccess === "anyone". */
  linkRole: Role;
  link: string;
}

export type SaveStatus = "saved" | "saving" | "unsaved" | "error";

export type DocFilter = "all" | "recent" | "starred" | "shared" | "trash";

export type SortKey = "updated" | "title" | "status";
