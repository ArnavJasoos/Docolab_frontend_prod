"use client";

import * as React from "react";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { useDocument } from "@/lib/store/document-store";
import { RENAME_EVENT } from "@/components/editor/use-doc-actions";

/** Inline-editable document name that auto-sizes to its content. */
export function DocTitle() {
  const { title, setTitle, saveNow, readOnly, loading } = useDocument();
  const sizerRef = React.useRef<HTMLSpanElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [width, setWidth] = React.useState(120);

  React.useLayoutEffect(() => {
    if (sizerRef.current) {
      setWidth(Math.min(Math.max(sizerRef.current.offsetWidth + 4, 160), 640));
    }
  }, [title]);

  // The "Rename" menu action focuses and selects the title.
  React.useEffect(() => {
    const onRename = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener(RENAME_EVENT, onRename);
    return () => window.removeEventListener(RENAME_EVENT, onRename);
  }, []);

  if (loading) {
    return <div className="h-5 w-40 animate-pulse rounded bg-surface-container" />;
  }

  return (
    <div className="relative flex min-w-0 items-center">
      <span
        ref={sizerRef}
        aria-hidden
        className="pointer-events-none invisible absolute whitespace-pre font-ui-base text-ui-base font-semibold"
      >
        {title || "Untitled document"}
      </span>
      <input
        ref={inputRef}
        value={title}
        readOnly={readOnly}
        aria-label="Document title"
        spellCheck={false}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={() => void saveNow()}
        style={{ width }}
        placeholder="Untitled document"
        className={cn(
          "min-w-0 truncate rounded-md bg-transparent px-1.5 py-0.5 font-ui-base text-ui-base font-semibold text-text-primary",
          "outline-none transition-colors hover:bg-surface-container focus:bg-surface-container",
          "placeholder:text-text-muted read-only:hover:bg-transparent",
        )}
      />
    </div>
  );
}

function relativeLabel(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Live save indicator: Saving… / Saved · 2m ago / Unsaved / retry on error. */
export function SaveStatus() {
  const { saveStatus, lastSavedAt, saveNow } = useDocument();
  const [, force] = React.useReducer((n: number) => n + 1, 0);

  // Refresh the relative timestamp periodically while idle.
  React.useEffect(() => {
    if (saveStatus !== "saved") return;
    const h = setInterval(force, 30_000);
    return () => clearInterval(h);
  }, [saveStatus]);

  if (saveStatus === "saving") {
    return (
      <span className="flex items-center gap-1.5 font-ui-xs text-ui-xs font-medium text-text-muted">
        <Icon name="progress_activity" size={16} className="animate-spin" />
        Saving…
      </span>
    );
  }

  if (saveStatus === "unsaved") {
    return (
      <span className="flex items-center gap-1.5 font-ui-xs text-ui-xs font-medium text-text-muted">
        <Icon name="edit" size={16} />
        Unsaved changes
      </span>
    );
  }

  if (saveStatus === "error") {
    return (
      <button
        onClick={() => void saveNow()}
        className="flex items-center gap-1.5 font-ui-xs text-ui-xs font-medium text-status-destructive hover:underline"
      >
        <Icon name="cloud_off" size={16} />
        Save failed — retry
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1.5 font-ui-xs text-ui-xs font-medium text-text-muted">
      <Icon name="cloud_done" size={16} fill className="text-insertion-text" />
      Saved
      {lastSavedAt && (
        <span className="text-text-muted/70">· {relativeLabel(lastSavedAt)}</span>
      )}
    </span>
  );
}
