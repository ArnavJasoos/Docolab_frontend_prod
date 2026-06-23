"use client";

import Link from "next/link";
import { toast } from "sonner";

import type { DocFilter } from "@/lib/types";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

const NAV_ITEMS: { label: string; icon: string; filter: DocFilter }[] = [
  { label: "Documents", icon: "folder", filter: "all" },
  { label: "Shared with me", icon: "group", filter: "shared" },
  { label: "Recent", icon: "schedule", filter: "recent" },
  { label: "Starred", icon: "star", filter: "starred" },
  { label: "Trash", icon: "delete", filter: "trash" },
];

export function SideNav({ activeFilter = "all" }: { activeFilter?: DocFilter }) {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col gap-sm border-r border-border-subtle bg-surface-container-low px-md py-lg font-ui-sm text-ui-sm text-on-surface">
      <div className="mb-md flex items-center gap-sm px-sm">
        <div className="flex size-8 items-center justify-center rounded bg-primary-container text-on-primary shadow-sm">
          <Icon name="domain" size={16} />
        </div>
        <div className="flex flex-col">
          <span className="font-ui-base text-ui-base font-semibold">Workspace</span>
          <span className="font-ui-xs text-ui-xs text-text-muted">All documents</span>
        </div>
      </div>

      <Link
        href="/editor"
        className="mb-sm flex w-full items-center justify-center gap-xs rounded-lg bg-primary-container px-3 py-2 font-ui-sm text-ui-sm font-medium text-on-primary shadow-sm transition-colors hover:bg-accent-hover"
      >
        <Icon name="add" size={18} />
        New Document
      </Link>

      <nav className="flex flex-1 flex-col gap-xs overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const active = item.filter === activeFilter;
          const href =
            item.filter === "all" ? "/browser" : `/browser?filter=${item.filter}`;
          return (
            <Link
              key={item.label}
              href={href}
              className={cn(
                "flex items-center gap-sm rounded-lg px-3 py-2 duration-200 ease-in-out",
                active
                  ? "bg-secondary-container font-semibold text-on-secondary-container"
                  : "text-on-surface-variant transition-all hover:bg-surface-container-high",
              )}
            >
              <Icon name={item.icon} fill={active} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-xs border-t border-border-subtle pt-sm">
        <button
          onClick={() => toast.info("Settings — coming soon")}
          className="flex items-center gap-sm rounded-lg px-3 py-2 text-on-surface-variant transition-all duration-200 ease-in-out hover:bg-surface-container-high"
        >
          <Icon name="settings" />
          Settings
        </button>
        <button
          onClick={() => toast.info("Help center — coming soon")}
          className="flex items-center gap-sm rounded-lg px-3 py-2 text-on-surface-variant transition-all duration-200 ease-in-out hover:bg-surface-container-high"
        >
          <Icon name="help_outline" />
          Help
        </button>
      </div>
    </aside>
  );
}
