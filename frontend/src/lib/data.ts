export type DocStatus = "Working" | "Pending Review" | "Approved" | "Draft";

export type Doc = {
  id: string;
  title: string;
  status: DocStatus;
  version: string;
  updated: string;
};

export const STATUS_CLASS: Record<DocStatus, string> = {
  Working: "bg-accent-bg text-primary-container border-[#C7D2FE]",
  "Pending Review": "bg-surface-container text-text-secondary border-border-subtle",
  Approved: "bg-insertion-bg text-insertion-text border-[#BBF7D0]",
  Draft: "bg-surface-container text-text-secondary border-border-subtle",
};

export const DOCS: Doc[] = [
  {
    id: "q3-marketing",
    title: "Q3 Marketing Strategy & Budget Allocation",
    status: "Working",
    version: "v2.4",
    updated: "2h ago by Sarah",
  },
  {
    id: "eng-onboarding",
    title: "Engineering Onboarding Guide 2024",
    status: "Pending Review",
    version: "v1.1",
    updated: "yesterday",
  },
  {
    id: "client-api",
    title: "Client API Documentation - Internal Draft",
    status: "Approved",
    version: "v3.0",
    updated: "Oct 12",
  },
  {
    id: "project-phoenix",
    title: "Project Phoenix - Architecture Spec",
    status: "Working",
    version: "v0.5",
    updated: "5m ago by You",
  },
  {
    id: "weekly-sync",
    title: "Meeting Notes: Weekly Sync",
    status: "Draft",
    version: "v0.1",
    updated: "Oct 10",
  },
];
