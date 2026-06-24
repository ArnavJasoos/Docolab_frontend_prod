// =============================================================================
// lib/api/collaborators.ts — document sharing built on the real backend
// access-control endpoints (roles / assignments / users / ownership). No seeded
// people remain.
//
// Notes / current limits:
//   - The backend has no "anyone with the link" sharing, so generalAccess is a
//     client-only toggle (not persisted) and defaults to "restricted".
//   - Live presence is Yjs/Hocuspocus awareness; getPresence() returns the
//     current session user for now (multi-user awareness is the follow-up).
// =============================================================================

import type {
  Collaborator,
  GeneralAccess,
  PresenceUser,
  Role,
  ShareState,
  User,
} from "@/lib/types";
import type { UiRole } from "@/lib/roles";
import { getCurrentUser } from "@/lib/api/auth";
import * as assignments from "@/lib/api/assignments";

// --- role vocabulary bridges -------------------------------------------------
function roleToUi(role: Role): UiRole {
  switch (role) {
    case "owner":
      return "Owner";
    case "editor":
    case "commenter":
      return "Collaborator";
    default:
      return "Viewer";
  }
}

function backendNameToRole(name: string): Role {
  switch (name) {
    case "owner":
      return "owner";
    case "editor":
    case "approver":
      return "editor";
    default:
      return "viewer";
  }
}

function orgUserToUser(u: assignments.OrgUser): User {
  return { id: u.id, name: u.display_name, email: u.email };
}

// --- share state -------------------------------------------------------------
export async function getShareState(docId: string): Promise<ShareState> {
  const [entries, users] = await Promise.all([
    assignments.listAssignments(docId),
    assignments.listOrgUsers(),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const collaborators: Collaborator[] = entries.map((e) => {
    const ou = byId.get(e.user_id);
    const user: User = ou
      ? orgUserToUser(ou)
      : { id: e.user_id, name: "Unknown user", email: "" };
    return { user, role: backendNameToRole(e.role_name) };
  });
  return {
    collaborators,
    generalAccess: "restricted",
    linkRole: "viewer",
    link: typeof window !== "undefined" ? window.location.href : "",
  };
}

/** Roster typeahead: org members not already on the doc, minus the current user. */
export async function searchUsers(docId: string, query: string): Promise<User[]> {
  const [entries, users] = await Promise.all([
    assignments.listAssignments(docId),
    assignments.listOrgUsers(),
  ]);
  const taken = new Set(entries.map((e) => e.user_id));
  const me = getCurrentUser()?.id;
  const q = query.trim().toLowerCase();
  return users
    .filter((u) => !taken.has(u.id) && u.id !== me)
    .filter(
      (u) =>
        !q ||
        u.display_name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    )
    .map(orgUserToUser)
    .slice(0, 6);
}

/** Invite a known roster user by id. */
export async function inviteUser(
  docId: string,
  user: User,
  role: Role,
): Promise<ShareState> {
  await assignments.assignRole(docId, user.id, roleToUi(role));
  return getShareState(docId);
}

/** Invite by email — the user must already be an org member (no external invites). */
export async function inviteCollaborator(
  docId: string,
  email: string,
  role: Role,
): Promise<ShareState> {
  const users = await assignments.listOrgUsers();
  const match = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!match) {
    throw new Error("No organization member with that email.");
  }
  await assignments.assignRole(docId, match.id, roleToUi(role));
  return getShareState(docId);
}

export async function updateCollaboratorRole(
  docId: string,
  userId: string,
  role: Role,
): Promise<ShareState> {
  const entries = await assignments.listAssignments(docId);
  const current = entries.find((e) => e.user_id === userId);
  if (current) {
    await assignments.changeRole(docId, userId, current.id, roleToUi(role));
  }
  return getShareState(docId);
}

export async function removeCollaborator(
  docId: string,
  userId: string,
): Promise<ShareState> {
  const entries = await assignments.listAssignments(docId);
  const current = entries.find((e) => e.user_id === userId);
  if (current) await assignments.revokeAssignment(current.id);
  return getShareState(docId);
}

/** Client-only general-access toggle (backend has no link sharing yet). */
export async function setGeneralAccess(
  docId: string,
  generalAccess: GeneralAccess,
  linkRole?: Role,
): Promise<ShareState> {
  const state = await getShareState(docId);
  return { ...state, generalAccess, linkRole: linkRole ?? state.linkRole };
}

/**
 * Live presence. The canonical source is Yjs/Hocuspocus awareness; until that
 * is wired into this hook, return the current session user as active.
 */
export async function getPresence(docId: string): Promise<PresenceUser[]> {
  void docId;
  const me = getCurrentUser();
  if (!me) return [];
  return [{ ...me, hue: me.hue ?? "violet", state: "active" }];
}
