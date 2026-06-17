import type { Value } from "platejs";

import type { DocumentRecord, PresenceHue, User } from "@/lib/types";

const avatar = (seed: string) =>
  `https://api.dicebear.com/9.x/glass/svg?seed=${seed}`;

/** The signed-in user. Backend replaces this with the real session. */
export const CURRENT_USER: User = {
  id: "you",
  name: "You",
  email: "you@company.com",
  avatarUrl: avatar("docflow-you"),
  hue: "violet",
};

export const USERS: User[] = [
  CURRENT_USER,
  { id: "sarah", name: "Sarah Chen", email: "sarah@company.com", avatarUrl: avatar("sarah9"), hue: "teal" },
  { id: "marcus", name: "Marcus Reed", email: "marcus@company.com", avatarUrl: avatar("marcus3"), hue: "amber" },
  { id: "priya", name: "Priya Nair", email: "priya@company.com", avatarUrl: avatar("priya7"), hue: "rose" },
  { id: "diego", name: "Diego Alvarez", email: "diego@company.com", avatarUrl: avatar("diego1"), hue: "sky" },
  { id: "lena", name: "Lena Hoffmann", email: "lena@company.com", avatarUrl: avatar("lena5"), hue: "lime" },
];

export const HUES: PresenceHue[] = [
  "violet",
  "teal",
  "amber",
  "rose",
  "sky",
  "lime",
  "fuchsia",
  "orange",
];

export function userById(id: string): User | undefined {
  return USERS.find((u) => u.id === id);
}

const nexusContent: Value = [
  { type: "h1", children: [{ text: "Project Nexus: Strategic Initiative Q3" }] },
  { type: "h2", children: [{ text: "1. Executive Summary" }] },
  {
    type: "p",
    children: [
      {
        text: "The current market conditions necessitate a paradigm shift in how we approach enterprise collaboration. Project Nexus aims to bridge the gap between structured documentation and fluid, real-time communication. By unifying these paradigms, we project a 24% increase in cross-functional team velocity.",
      },
    ],
  },
  {
    type: "p",
    children: [
      {
        text: "Initial qualitative research indicates that context-switching between specialized tools is the primary bottleneck for our engineering and design cohorts.",
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
  { type: "h2", children: [{ text: "2. Market Analysis" }] },
  {
    type: "p",
    children: [
      {
        text: "Competitors have largely focused on horizontal integration, prioritizing breadth over depth. Our strategy, conversely, focuses on a vertical, highly specialized experience tailored for technical editing and review workflows.",
      },
    ],
  },
];

/** Generates a plausible body for a seeded document from its title. */
function genericContent(title: string): Value {
  return [
    { type: "h1", children: [{ text: title }] },
    {
      type: "p",
      children: [
        {
          text: "This document is a working draft. Use the toolbar, the slash menu, or the AI assistant to start editing. Changes autosave as you type.",
        },
      ],
    },
    { type: "h2", children: [{ text: "Overview" }] },
    {
      type: "p",
      children: [
        {
          text: "Replace this section with the relevant context, goals, and scope. Collaborators can comment on any block and suggest edits inline.",
        },
      ],
    },
    { type: "h3", children: [{ text: "Next steps" }] },
    { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "Outline the key sections." }] },
    { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "Invite reviewers and assign roles." }] },
    { type: "p", indent: 1, listStyleType: "disc", children: [{ text: "Move to review when ready." }] },
  ];
}

const now = Date.now();
const hrs = (n: number) => new Date(now - n * 3_600_000).toISOString();
const days = (n: number) => new Date(now - n * 86_400_000).toISOString();

export const SEED_DOCS: DocumentRecord[] = [
  {
    id: "project-nexus",
    title: "Project Nexus: Strategic Initiative Q3",
    status: "Working",
    version: "v2.4",
    updatedAt: hrs(2),
    updatedLabel: "2h ago by Sarah",
    ownerId: "you",
    starred: true,
    trashed: false,
    collaboratorCount: 4,
    content: nexusContent,
  },
  {
    id: "q3-marketing",
    title: "Q3 Marketing Strategy & Budget Allocation",
    status: "Working",
    version: "v2.4",
    updatedAt: hrs(2),
    updatedLabel: "2h ago by Sarah",
    ownerId: "sarah",
    starred: true,
    trashed: false,
    collaboratorCount: 3,
    content: genericContent("Q3 Marketing Strategy & Budget Allocation"),
  },
  {
    id: "eng-onboarding",
    title: "Engineering Onboarding Guide 2024",
    status: "Pending Review",
    version: "v1.1",
    updatedAt: days(1),
    updatedLabel: "yesterday",
    ownerId: "marcus",
    starred: false,
    trashed: false,
    collaboratorCount: 6,
    content: genericContent("Engineering Onboarding Guide 2024"),
  },
  {
    id: "client-api",
    title: "Client API Documentation - Internal Draft",
    status: "Approved",
    version: "v3.0",
    updatedAt: days(4),
    updatedLabel: "Oct 12",
    ownerId: "you",
    starred: false,
    trashed: false,
    collaboratorCount: 2,
    content: genericContent("Client API Documentation - Internal Draft"),
  },
  {
    id: "project-phoenix",
    title: "Project Phoenix - Architecture Spec",
    status: "Working",
    version: "v0.5",
    updatedAt: hrs(0.1),
    updatedLabel: "5m ago by You",
    ownerId: "you",
    starred: true,
    trashed: false,
    collaboratorCount: 5,
    content: genericContent("Project Phoenix - Architecture Spec"),
  },
  {
    id: "weekly-sync",
    title: "Meeting Notes: Weekly Sync",
    status: "Draft",
    version: "v0.1",
    updatedAt: days(6),
    updatedLabel: "Oct 10",
    ownerId: "priya",
    starred: false,
    trashed: false,
    collaboratorCount: 4,
    content: genericContent("Meeting Notes: Weekly Sync"),
  },
  {
    id: "archived-rfc",
    title: "RFC: Legacy Auth Deprecation",
    status: "Draft",
    version: "v0.3",
    updatedAt: days(20),
    updatedLabel: "3 weeks ago",
    ownerId: "you",
    starred: false,
    trashed: true,
    collaboratorCount: 2,
    content: genericContent("RFC: Legacy Auth Deprecation"),
  },
];

export { genericContent };
