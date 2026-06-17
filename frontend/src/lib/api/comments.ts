import type { TComment } from "@/components/ui/comment";

import { latency, read, write } from "@/lib/api/db";
import { CURRENT_USER, USERS } from "@/lib/api/seed";

export type TDiscussion = {
  id: string;
  comments: TComment[];
  createdAt: Date;
  isResolved: boolean;
  userId: string;
  documentContent?: string;
};

export type DiscussionUser = {
  id: string;
  name: string;
  avatarUrl: string;
  hue?: number;
};

const avatar = (seed: string) =>
  `https://api.dicebear.com/9.x/glass/svg?seed=${seed}`;

/** Plugin-shaped user map keyed by id, derived from the shared roster. */
export const USERS_MAP: Record<string, DiscussionUser> = Object.fromEntries(
  USERS.map((u) => [
    u.id,
    { id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? avatar(u.id) },
  ]),
);

export const CURRENT_USER_ID = CURRENT_USER.id;

function p(text: string) {
  return [{ type: "p", children: [{ text }] }];
}

const keyFor = (docId: string) => `discussions:${docId}`;

export const SEED_DISCUSSIONS: TDiscussion[] = [
  {
    id: "discussion1",
    userId: "sarah",
    createdAt: new Date(Date.now() - 3_600_000),
    isResolved: false,
    documentContent: "paradigm shift in how we approach enterprise collaboration",
    comments: [
      {
        id: "c1",
        userId: "sarah",
        discussionId: "discussion1",
        contentRich: p("Can we quantify the 24% velocity claim with the source study?"),
        createdAt: new Date(Date.now() - 3_600_000),
        isEdited: false,
      },
      {
        id: "c2",
        userId: "you",
        discussionId: "discussion1",
        contentRich: p("Good call — I'll link the research appendix here."),
        createdAt: new Date(Date.now() - 1_800_000),
        isEdited: false,
      },
    ],
  },
  {
    id: "discussion2",
    userId: "marcus",
    createdAt: new Date(Date.now() - 7_200_000),
    isResolved: true,
    documentContent: "single source of truth for product specifications",
    comments: [
      {
        id: "c3",
        userId: "marcus",
        discussionId: "discussion2",
        contentRich: p("Aligned. This matches the platform RFC we approved last week."),
        createdAt: new Date(Date.now() - 7_200_000),
        isEdited: false,
      },
    ],
  },
];

/** Revive Date fields that JSON round-tripping flattens to strings. */
function reviveDates(discussions: TDiscussion[]): TDiscussion[] {
  return discussions.map((d) => ({
    ...d,
    createdAt: new Date(d.createdAt),
    comments: d.comments.map((c) => ({ ...c, createdAt: new Date(c.createdAt) })),
  }));
}

export async function getDiscussions(docId: string): Promise<TDiscussion[]> {
  await latency(120);
  const stored = read<TDiscussion[] | null>(keyFor(docId), null);
  if (stored) return reviveDates(stored);
  write(keyFor(docId), SEED_DISCUSSIONS);
  return SEED_DISCUSSIONS;
}

/** Persist the full discussion list. Called after inline/sidebar mutations. */
export async function saveDiscussions(
  docId: string,
  discussions: TDiscussion[],
): Promise<void> {
  write(keyFor(docId), discussions);
}
