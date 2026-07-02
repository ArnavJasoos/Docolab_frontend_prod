"use client";

import * as React from "react";
import { toast } from "sonner";
import type { Value } from "platejs";

import type { DocStatus, DocumentRecord, SaveStatus } from "@/lib/types";
import * as documentsApi from "@/lib/api/documents";
import {
  capsForRole,
  getMyAccess,
  toBackendRole,
  toUiRole,
  type BackendRole,
  type Caps,
  type UiRole,
} from "@/lib/roles";
import { getCurrentUser } from "@/lib/api/auth";

const AUTOSAVE_DELAY = 1200;

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
  /** Effective capabilities for the current (or previewed) role. */
  caps: Caps;
  /** UI role label for the signed-in user on this doc (null = no access yet). */
  uiRole: UiRole | null;
  /** The user's REAL role (ignores preview). Used to bound the preview switcher
   *  so it can only downgrade, never escalate. */
  realUiRole: UiRole | null;
  /** Owner/Manager "preview as role" override (null = use the real role). */
  previewRole: UiRole | null;
  setPreviewRole: (r: UiRole | null) => void;
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
  const [resolvedRole, setResolvedRole] = React.useState<BackendRole | null>(null);
  const [previewRole, setPreviewRole] = React.useState<UiRole | null>(null);

  const contentRef = React.useRef<Value | null>(null);
  const titleRef = React.useRef("");
  const statusRef = React.useRef<DocStatus>("Draft");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = React.useRef(docId);
  const loadedRef = React.useRef(false);
  // Caches the in-flight "create blank doc" request, keyed by docId. React 18
  // StrictMode runs effects twice in dev; without this both runs fire their own
  // POST /documents and two blank docs are created. Sharing one promise → one POST.
  const createPromiseRef = React.useRef<{ key: string; promise: Promise<DocumentRecord> } | null>(null);

  // Load (or lazily create) the document for this id.
  React.useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    (async () => {
      setLoading(true);
      // "new" (or empty) is the sentinel for "no doc yet" — don't hit the
      // backend with it (the id isn't a UUID → 500). Create straight away.
      const isNew = !docId || docId === "new";
      let record = isNew ? null : await documentsApi.getDocument(docId);
      if (!record && !isNew) {
        // A real id that failed to load (deleted, no access, or backend down).
        // Never fall through to create — that silently spawned a fresh blank
        // "Untitled document" on every failed open. Send the user back instead.
        if (cancelled) return;
        toast.error("Couldn't open this document — it may have been deleted or you may not have access.");
        if (typeof window !== "undefined") window.location.replace("/browser");
        return;
      }
      if (!record) {
        // Reuse the in-flight create for this docId so StrictMode's double
        // effect run issues a single POST instead of two blank documents.
        if (createPromiseRef.current?.key !== docId) {
          createPromiseRef.current = {
            key: docId,
            promise: documentsApi.createDocument("Untitled document"),
          };
        }
        record = await createPromiseRef.current.promise;
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

  // Resolve the signed-in user's effective backend role on this document
  // (folder inheritance included) via the backend authorize-check.
  React.useEffect(() => {
    let cancelled = false;
    // Wait for a real (created) doc id before asking the backend for access.
    if (!resolvedId || resolvedId === "new") return;
    void getMyAccess(resolvedId)
      .then((a) => {
        if (!cancelled) setResolvedRole(a.backendRole);
      })
      .catch(() => {
        /* backend unreachable — leave role unresolved (no-access caps) */
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedId]);

  const flush = React.useCallback(async () => {
    if (!loadedRef.current) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSaveStatus("saving");
    try {
      // Content is owned by Yjs/Hocuspocus (real-time, canonical). Autosave only
      // persists governance/metadata here — sending `content` would clobber the
      // live shared doc with a stale REST snapshot.
      await documentsApi.updateDocument(idRef.current, {
        title: titleRef.current,
        status: statusRef.current,
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

  // Flush pending autosave on unmount (don't just drop the timer — a rename
  // followed by an immediate navigation was silently lost).
  React.useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void flush();
      }
    };
  }, [flush]);

  const me = getCurrentUser();
  const isCreator = !!(doc && me && doc.ownerId === me.id);
  const realUiRole = toUiRole(resolvedRole, isCreator);

  // "Preview as role" may only DOWNGRADE the view (e.g. an Owner previewing a
  // Viewer's read-only experience). It must never UPGRADE: a Viewer previewing
  // as Owner would otherwise gain edit/approve capabilities client-side
  // (privilege escalation). We clamp the previewed role to the user's real
  // resolved role by rank, so caps can never exceed what the backend granted.
  const ROLE_RANK: Record<BackendRole, number> = {
    viewer: 0,
    editor: 1,
    approver: 2,
    owner: 3,
  };
  const previewBackendRole = previewRole ? toBackendRole(previewRole) : null;
  const previewAllowed =
    !!previewBackendRole &&
    !!resolvedRole &&
    ROLE_RANK[previewBackendRole] <= ROLE_RANK[resolvedRole];
  const effectiveBackendRole: BackendRole | null = previewAllowed
    ? previewBackendRole
    : resolvedRole;
  const caps = capsForRole(effectiveBackendRole);
  const uiRole = previewAllowed ? (previewRole as UiRole) : realUiRole;

  // Role-enforced read-only. A user without edit capability (viewer, or an
  // unresolved/no-access role) is ALWAYS read-only regardless of the manual
  // "Viewing/Editing" toggle — so they cannot type in the editor or trip
  // autosave. Users with edit rights may still opt into read-only via the
  // toggle. (The collab server independently rejects edits from viewers, so this
  // is the matching client-side guard, not the only one.)
  const effectiveReadOnly = readOnly || !caps.canEdit;

  const value = React.useMemo<DocumentContextValue>(
    () => ({
      docId: resolvedId,
      doc,
      loading,
      title,
      status,
      saveStatus,
      lastSavedAt,
      readOnly: effectiveReadOnly,
      commentsOpen,
      shareOpen,
      versionsOpen,
      caps,
      uiRole,
      realUiRole,
      previewRole,
      setPreviewRole,
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
      effectiveReadOnly,
      commentsOpen,
      shareOpen,
      versionsOpen,
      caps,
      uiRole,
      realUiRole,
      previewRole,
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
