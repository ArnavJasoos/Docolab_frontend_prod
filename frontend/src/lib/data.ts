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
