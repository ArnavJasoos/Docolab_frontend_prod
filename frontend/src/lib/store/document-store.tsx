"use client";

import * as React from "react";
import type { Value } from "platejs";

import type { DocStatus, DocumentRecord, SaveStatus } from "@/lib/types";
import * as documentsApi from "@/lib/api/documents";

const AUTOSAVE_DELAY = 1200;

// Mirrors plate-editor: with collaboration off (default), content is saved over
// REST; with it on, Yjs/Hocuspocus owns content and autosave skips it.
const COLLAB_ENABLED = process.env.NEXT_PUBLIC_COLLAB_ENABLED === "true";

interface DocumentContextValue {
  docId: string;
  doc: DocumentRecord | null;
  loading: boolean;
  title: string;
  status: DocStatus;
  saveStatus: SaveStatus;
  lastSavedAt: string | null;
  readOnly: boolean;
  commentsOpen: boolean;
  shareOpen: boolean;
  versionsOpen: boolean;
  setReadOnly: (v: boolean) => void;
  toggleComments: () => void;
  setCommentsOpen: (v: boolean) => void;
  setShareOpen: (v: boolean) => void;
  setVersionsOpen: (v: boolean) => void;
  setTitle: (t: string) => void;
  setStatus: (s: DocStatus) => void;
  onContentChange: (value: Value) => void;
  saveNow: () => Promise<void>;
}

const DocumentContext = React.createContext<DocumentContextValue | null>(null);

export function useDocument(): DocumentContextValue {
  const ctx = React.useContext(DocumentContext);
  if (!ctx) throw new Error("useDocument must be used within <DocumentProvider>");
  return ctx;
}

/** Optional consumer for components that may render outside a provider. */
export function useDocumentOptional(): DocumentContextValue | null {
  return React.useContext(DocumentContext);
}

export function DocumentProvider({
  docId,
  children,
}: {
  docId: string;
  children: React.ReactNode;
}) {
  const [doc, setDoc] = React.useState<DocumentRecord | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [title, setTitleState] = React.useState("");
  const [status, setStatusState] = React.useState<DocStatus>("Draft");
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("saved");
  const [lastSavedAt, setLastSavedAt] = React.useState<string | null>(null);
  const [readOnly, setReadOnly] = React.useState(false);
  const [commentsOpen, setCommentsOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [resolvedId, setResolvedId] = React.useState(docId);

  const contentRef = React.useRef<Value | null>(null);
  const titleRef = React.useRef("");
  const statusRef = React.useRef<DocStatus>("Draft");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = React.useRef(docId);
  const loadedRef = React.useRef(false);

  // Load (or lazily create) the document for this id.
  React.useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    (async () => {
      setLoading(true);
      let record = await documentsApi.getDocument(docId);
      if (!record) {
        record = await documentsApi.createDocument("Untitled document");
        // Pin the freshly created doc to the URL so a refresh reopens it
        // instead of spawning yet another blank document.
        if (typeof window !== "undefined") {
          window.history.replaceState(null, "", `/editor?doc=${record.id}`);
        }
      }
      if (cancelled) return;
      idRef.current = record.id;
      setResolvedId(record.id);
      contentRef.current = record.content;
      titleRef.current = record.title;
      statusRef.current = record.status;
      setDoc(record);
      setTitleState(record.title);
      setStatusState(record.status);
      setLastSavedAt(record.updatedAt);
      setSaveStatus("saved");
      setLoading(false);
      loadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const flush = React.useCallback(async () => {
    if (!loadedRef.current) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSaveStatus("saving");
    try {
      // When collaboration is on, content is owned by Yjs/Hocuspocus and autosave
      // only persists governance/metadata (sending `content` would clobber the
      // live shared doc). When collab is off (default — no sync server yet),
      // persist `content` too so local edits are actually saved.
      await documentsApi.updateDocument(idRef.current, {
        title: titleRef.current,
        status: statusRef.current,
        ...(COLLAB_ENABLED ? {} : { content: contentRef.current ?? undefined }),
      });
      setSaveStatus("saved");
      setLastSavedAt(new Date().toISOString());
    } catch {
      setSaveStatus("error");
    }
  }, []);

  const schedule = React.useCallback(() => {
    if (!loadedRef.current || readOnly) return;
    setSaveStatus("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY);
  }, [flush, readOnly]);

  const setTitle = React.useCallback(
    (t: string) => {
      titleRef.current = t;
      setTitleState(t);
      schedule();
    },
    [schedule],
  );

  const setStatus = React.useCallback(
    (s: DocStatus) => {
      statusRef.current = s;
      setStatusState(s);
      schedule();
    },
    [schedule],
  );

  const onContentChange = React.useCallback(
    (value: Value) => {
      // Ignore selection-only changes (Plate reuses the children reference).
      if (value === contentRef.current) return;
      contentRef.current = value;
      schedule();
    },
    [schedule],
  );

  const saveNow = React.useCallback(async () => {
    await flush();
  }, [flush]);

  // Flush pending autosave on unmount.
  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const value = React.useMemo<DocumentContextValue>(
    () => ({
      docId: resolvedId,
      doc,
      loading,
      title,
      status,
      saveStatus,
      lastSavedAt,
      readOnly,
      commentsOpen,
      shareOpen,
      versionsOpen,
      setReadOnly,
      toggleComments: () => setCommentsOpen((v) => !v),
      setCommentsOpen,
      setShareOpen,
      setVersionsOpen,
      setTitle,
      setStatus,
      onContentChange,
      saveNow,
    }),
    [
      resolvedId,
      doc,
      loading,
      title,
      status,
      saveStatus,
      lastSavedAt,
      readOnly,
      commentsOpen,
      shareOpen,
      versionsOpen,
      setTitle,
      setStatus,
      onContentChange,
      saveNow,
    ],
  );

  return (
    <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>
  );
}
