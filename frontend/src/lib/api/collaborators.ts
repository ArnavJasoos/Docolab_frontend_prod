import type {
  Collaborator,
  GeneralAccess,
  PresenceUser,
  Role,
  ShareState,
  User,
} from "@/lib/types";
import { latency, read, write } from "@/lib/api/db";
import { CURRENT_USER, HUES, USERS } from "@/lib/api/seed";

const keyFor = (docId: string) => `share:${docId}`;

function seedShare(docId: string): ShareState {
  const others = USERS.filter((u) => u.id !== CURRENT_USER.id);
  const collaborators: Collaborator[] = [
    { user: CURRENT_USER, role: "owner" },
    ...others.slice(0, 3).map((user, i): Collaborator => ({
      user,
      role: i === 0 ? "editor" : i === 1 ? "commenter" : "viewer",
    })),
  ];
  return {
    collaborators,
    generalAccess: "restricted",
    linkRole: "viewer",
    link: `https://docflow.app/d/${docId}`,
  };
}

function load(docId: string): ShareState {
  const existing = read<ShareState | null>(keyFor(docId), null);
  if (existing) return existing;
  const seeded = seedShare(docId);
  write(keyFor(docId), seeded);
  return seeded;
}

export async function getShareState(docId: string): Promise<ShareState> {
  await latency(120);
  return load(docId);
}

function findUserByEmail(email: string): User | undefined {
  return USERS.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

/**
 * Roster typeahead for the share dialog. Returns known org members matching
 * `query` (by name or email) who are not already collaborators on the doc, so
 * the owner picks people by name and the backend receives a real user id.
 */
export async function searchUsers(
  docId: string,
  query: string,
): Promise<User[]> {
  await latency(60);
  const taken = new Set(load(docId).collaborators.map((c) => c.user.id));
  const q = query.trim().toLowerCase();
  return USERS.filter((u) => !taken.has(u.id)).filter(
    (u) =>
      !q ||
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q),
  ).slice(0, 6);
}

/** Invite an already-known roster user by id (name flows to the backend). */
export async function inviteUser(
  docId: string,
  user: User,
  role: Role,
): Promise<ShareState> {
  await latency(140);
  const state = load(docId);
  const without = state.collaborators.filter((c) => c.user.id !== user.id);
  const next: ShareState = {
    ...state,
    collaborators: [...without, { user, role }],
  };
  write(keyFor(docId), next);
  return next;
}

export async function inviteCollaborator(
  docId: string,
  email: string,
  role: Role,
): Promise<ShareState> {
  await latency();
  const state = load(docId);
  const existing = findUserByEmail(email);
  const name = email.split("@")[0].replace(/[._-]/g, " ");
  const user: User = existing ?? {
    id: email.toLowerCase(),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    email,
    hue: HUES[state.collaborators.length % HUES.length],
  };
  const without = state.collaborators.filter((c) => c.user.id !== user.id);
  const next: ShareState = {
    ...state,
    collaborators: [...without, { user, role }],
  };
  write(keyFor(docId), next);
  return next;
}

export async function updateCollaboratorRole(
  docId: string,
  userId: string,
  role: Role,
): Promise<ShareState> {
  await latency(100);
  const state = load(docId);
  const next: ShareState = {
    ...state,
    collaborators: state.collaborators.map((c) =>
      c.user.id === userId ? { ...c, role } : c,
    ),
  };
  write(keyFor(docId), next);
  return next;
}

export async function removeCollaborator(
  docId: string,
  userId: string,
): Promise<ShareState> {
  await latency(100);
  const state = load(docId);
  const next: ShareState = {
    ...state,
    collaborators: state.collaborators.filter((c) => c.user.id !== userId),
  };
  write(keyFor(docId), next);
  return next;
}

export async function setGeneralAccess(
  docId: string,
  generalAccess: GeneralAccess,
  linkRole?: Role,
): Promise<ShareState> {
  await latency(100);
  const state = load(docId);
  const next: ShareState = {
    ...state,
    generalAccess,
    linkRole: linkRole ?? state.linkRole,
  };
  write(keyFor(docId), next);
  return next;
}

/**
 * Live presence. Backend swaps this for a realtime channel (e.g. Supabase
 * Realtime / Yjs awareness); the UI only depends on the returned shape.
 */
export async function getPresence(docId: string): Promise<PresenceUser[]> {
  await latency(80);
  const { collaborators } = load(docId);
  const active = collaborators
    .filter((c) => c.user.id !== CURRENT_USER.id)
    .slice(0, 3);
  return [
    { ...CURRENT_USER, hue: CURRENT_USER.hue ?? "violet", state: "active" },
    ...active.map((c, i): PresenceUser => ({
      ...c.user,
      hue: c.user.hue ?? HUES[i % HUES.length],
      state: i === active.length - 1 ? "idle" : "active",
    })),
  ];
}
