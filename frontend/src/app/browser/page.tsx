"use client";

import * as React from "react";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";

import type { DocFilter, DocStatus, DocSummary, SortKey } from "@/lib/types";
import { STATUS_CLASS } from "@/lib/data";
import { SideNav } from "@/components/side-nav";
import { TopNav } from "@/components/top-nav";
import { Icon } from "@/components/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import * as documents from "@/lib/api/documents";

const FILTER_TITLE: Record<DocFilter, string> = {
  all: "All Documents",
  recent: "Recent",
  starred: "Starred",
  shared: "Shared with me",
  trash: "Trash",
};

const FILTER_BLURB: Record<DocFilter, string> = {
  all: "Manage and organize your collaborative workspace.",
  recent: "Documents you've opened or edited lately.",
  starred: "Documents you've marked as important.",
  shared: "Documents other people have shared with you.",
  trash: "Items are permanently deleted after 30 days.",
};

const SORT_LABEL: Record<SortKey, string> = {
  updated: "Last modified",
  title: "Name",
  status: "Status",
};

const STATUS_OPTIONS: (DocStatus | "all")[] = [
  "all",
  "Working",
  "Pending Review",
  "Approved",
  "Draft",
];

function isFilter(v: string | null): v is DocFilter {
  return ["all", "recent", "starred", "shared", "trash"].includes(v ?? "");
}

function DocCard({
  doc,
  filter,
  onChanged,
}: {
  doc: DocSummary;
  filter: DocFilter;
  onChanged: () => void;
}) {
  const router = useRouter();
  const trashed = filter === "trash";
  const go = () => router.push(`/editor?doc=${doc.id}`);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const rename = async () => {
    const name = window.prompt("Rename document", doc.title);
    if (name && name !== doc.title) {
      await documents.updateDocument(doc.id, { title: name });
      onChanged();
    }
  };
  const star = async () => {
    await documents.toggleStar(doc.id);
    onChanged();
  };
  const duplicate = async () => {
    await documents.duplicateDocument(doc.id);
    toast.success("Copy created");
    onChanged();
  };
  const trash = async () => {
    await documents.setTrashed(doc.id, true);
    toast.success("Moved to trash");
    onChanged();
  };
  const restore = async () => {
    await documents.setTrashed(doc.id, false);
    toast.success("Restored");
    onChanged();
  };
  const remove = async () => {
    await documents.deleteForever(doc.id);
    toast.success("Deleted permanently");
    onChanged();
  };

  return (
    <div
      onClick={trashed ? undefined : go}
      role={trashed ? undefined : "button"}
      tabIndex={trashed ? undefined : 0}
      onKeyDown={(e) => {
        if (!trashed && (e.key === "Enter" || e.key === " ")) go();
      }}
      className={cn(
        "group flex h-48 flex-col rounded-lg border border-border-subtle bg-document-surface p-lg transition-all duration-200",
        !trashed && "cursor-pointer hover:border-border-strong hover:shadow-md",
        trashed && "opacity-80",
      )}
    >
      <div className="mb-auto flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded border px-2 py-0.5 font-ui-xs text-ui-xs",
              STATUS_CLASS[doc.status],
            )}
          >
            {doc.status}
          </span>
          <span className="rounded border border-border-subtle bg-surface-container-low px-2 py-0.5 font-code text-code text-text-muted">
            {doc.version}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {!trashed && (
            <button
              onClick={(e) => {
                stop(e);
                void star();
              }}
              aria-label={doc.starred ? "Unstar" : "Star"}
              className={cn(
                "flex size-7 items-center justify-center rounded-full transition-colors hover:bg-surface-container",
                doc.starred
                  ? "text-status-warning"
                  : "text-text-muted opacity-0 group-hover:opacity-100",
              )}
            >
              <Icon name="star" fill={doc.starred} size={18} />
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              onClick={stop}
              aria-label="Document actions"
              className="flex size-7 items-center justify-center rounded-full text-text-muted opacity-0 outline-none transition-colors group-hover:opacity-100 hover:bg-surface-container focus-visible:opacity-100"
            >
              <Icon name="more_horiz" size={20} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={stop} className="min-w-44">
              {trashed ? (
                <>
                  <DropdownMenuItem onSelect={() => void restore()}>
                    <Icon name="restore_from_trash" size={18} className="text-text-muted" />
                    Restore
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                    <Icon name="delete_forever" size={18} />
                    Delete forever
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem onSelect={go}>
                    <Icon name="open_in_new" size={18} className="text-text-muted" />
                    Open
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void rename()}>
                    <Icon name="edit" size={18} className="text-text-muted" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void duplicate()}>
                    <Icon name="content_copy" size={18} className="text-text-muted" />
                    Make a copy
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void star()}>
                    <Icon name="star" size={18} className="text-text-muted" />
                    {doc.starred ? "Remove star" : "Add star"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => void trash()}>
                    <Icon name="delete" size={18} />
                    Move to trash
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-4">
        <h2 className="mb-1 line-clamp-2 font-ui-lg text-ui-lg font-medium leading-tight text-text-primary transition-colors group-hover:text-primary-container">
          {doc.title}
        </h2>
        <div className="mt-3 flex items-center gap-1.5">
          <Icon name="history" className="text-text-muted" size={14} />
          <span className="font-ui-xs text-ui-xs text-text-muted">
            Updated {doc.updatedLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  icon,
  children,
}: {
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-xs rounded-md border border-border-subtle bg-surface px-3 py-1.5 font-ui-sm text-ui-sm text-text-secondary shadow-sm transition-colors hover:bg-surface-container">
      <Icon name={icon} size={16} />
      {children}
      <Icon name="expand_more" size={16} />
    </span>
  );
}

function BrowserContent() {
  const params = useSearchParams();
  const filterParam = params.get("filter");
  const filter: DocFilter = isFilter(filterParam) ? filterParam : "all";

  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("updated");
  const [statusFilter, setStatusFilter] = React.useState<DocStatus | "all">("all");
  const [docs, setDocs] = React.useState<DocSummary[] | null>(null);

  const load = React.useCallback(() => {
    void documents.listDocuments({ filter, sort, query }).then(setDocs);
  }, [filter, sort, query]);

  React.useEffect(() => {
    load();
  }, [load]);

  const visible = (docs ?? []).filter(
    (d) => statusFilter === "all" || d.status === statusFilter,
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <SideNav activeFilter={filter} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNav search={query} onSearchChange={setQuery} />
        <main className="flex-1 overflow-y-auto bg-app-bg p-margin-desktop">
          <div className="mb-lg flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="m-0 font-h1 text-h1 text-text-primary">
                {FILTER_TITLE[filter]}
              </h1>
              <p className="mt-xs font-ui-base text-ui-base text-text-secondary">
                {FILTER_BLURB[filter]}
              </p>
            </div>
            <div className="flex items-center gap-sm">
              <DropdownMenu>
                <DropdownMenuTrigger>
                  <ToolbarButton icon="filter_list">
                    {statusFilter === "all" ? "Filter" : statusFilter}
                  </ToolbarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {STATUS_OPTIONS.map((s) => (
                    <DropdownMenuItem key={s} onSelect={() => setStatusFilter(s)}>
                      <span className="flex-1">{s === "all" ? "All statuses" : s}</span>
                      {statusFilter === s && <Icon name="check" size={16} />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger>
                  <ToolbarButton icon="sort">Sort: {SORT_LABEL[sort]}</ToolbarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(Object.keys(SORT_LABEL) as SortKey[]).map((s) => (
                    <DropdownMenuItem key={s} onSelect={() => setSort(s)}>
                      <span className="flex-1">{SORT_LABEL[s]}</span>
                      {sort === s && <Icon name="check" size={16} />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {docs === null ? (
            <div className="grid grid-cols-1 gap-gutter md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-48 animate-pulse rounded-lg bg-surface-container" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState filter={filter} query={query} />
          ) : (
            <div className="grid grid-cols-1 gap-gutter md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visible.map((doc) => (
                <DocCard key={doc.id} doc={doc} filter={filter} onChanged={load} />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function EmptyState({ filter, query }: { filter: DocFilter; query: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-subtle py-24 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-surface-container text-text-muted">
        <Icon name={query ? "search_off" : filter === "trash" ? "delete" : "folder_open"} size={28} />
      </div>
      <p className="font-ui-lg text-ui-lg font-medium text-text-primary">
        {query ? "No documents match your search" : `Nothing in ${FILTER_TITLE[filter]}`}
      </p>
      {!query && filter !== "trash" && (
        <Link
          href="/editor"
          className="mt-1 flex items-center gap-xs rounded-lg bg-primary-container px-4 py-2 font-ui-sm text-ui-sm font-semibold text-on-primary hover:bg-accent-hover"
        >
          <Icon name="add" size={18} /> New document
        </Link>
      )}
    </div>
  );
}

export default function BrowserPage() {
  return (
    <Suspense>
      <BrowserContent />
    </Suspense>
  );
}
