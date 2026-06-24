"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Plate, usePlateEditor } from "platejs/react";
import { YjsPlugin } from "@platejs/yjs/react";

import type { DocumentRecord } from "@/lib/types";
import { EditorKit } from "@/components/editor/editor-kit";
import { createYjsPlugin } from "@/components/editor/plugins/yjs-kit";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { EditorTopBar } from "@/components/editor/editor-top-bar";

// The comments panel is only mounted when the user opens it, so keep it out of
// the initial editor chunk and load it on demand.
const CommentsPanel = dynamic(
  () =>
    import("@/components/editor/comments-panel").then((m) => m.CommentsPanel),
  { ssr: false },
);
import { DocumentProvider, useDocument } from "@/lib/store/document-store";
import { AuthGuard } from "@/components/auth-guard";

export function PlateEditor({ docId }: { docId: string }) {
  return (
    <AuthGuard>
      <DocumentProvider docId={docId}>
        <Workspace routeDocId={docId} />
      </DocumentProvider>
    </AuthGuard>
  );
}

function Workspace({ routeDocId }: { routeDocId: string }) {
  const { doc, loading } = useDocument();

  if (loading || !doc) return <LoadingShell />;
  // Re-mount the Plate editor when the underlying document changes.
  return <LoadedWorkspace key={doc.id} doc={doc} routeDocId={routeDocId} />;
}

// Real-time collaboration (Yjs + Hocuspocus) requires the collab WebSocket
// server to be running. That sync layer isn't deployed yet, so collaboration is
// opt-in via env — when off (the default) the editor initializes locally from
// the REST content and works standalone. Set NEXT_PUBLIC_COLLAB_ENABLED="true"
// (and NEXT_PUBLIC_COLLAB_URL) once the Hocuspocus server is available.
const COLLAB_ENABLED = process.env.NEXT_PUBLIC_COLLAB_ENABLED === "true";

function LoadedWorkspace({ doc, routeDocId }: { doc: DocumentRecord; routeDocId: string }) {
  // The Hocuspocus room is the canonical document id from the route (the real
  // backend UUID), NOT the local metadata record id — they coincide once the
  // document store talks to the real API, but the route id is authoritative for
  // collaboration so two clients on the same URL share a room.
  const editor = usePlateEditor({
    // With collab on, Yjs owns initialization (skip Plate's value seeding and
    // init the shared doc in the effect below). With collab off, seed normally
    // from the REST content so the editor works without the WebSocket server.
    skipInitialization: COLLAB_ENABLED,
    value: COLLAB_ENABLED ? undefined : doc.content,
    plugins: React.useMemo(
      () =>
        COLLAB_ENABLED
          ? [...EditorKit, createYjsPlugin(routeDocId)]
          : EditorKit,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  });
  const { readOnly, commentsOpen, saveNow, onContentChange } = useDocument();

  // Online editing (Yjs/Hocuspocus) is the canonical, persisted path. When the
  // collab server is unavailable the editor still opens, but edits are NOT
  // persisted — warn the user instead of silently losing their work.
  React.useEffect(() => {
    if (!COLLAB_ENABLED) {
      toast.warning("Offline mode — changes to this document won't be saved.", {
        duration: 6000,
      });
    }
  }, []);

  // Connect to Hocuspocus and seed the shared Y.Doc. On the very first connect
  // for a document (yjs_state is NULL server-side) the shared doc is empty, so
  // we seed it from the REST `content` we already loaded. Once content lives in
  // Yjs, that seed is ignored (init only seeds when the shared doc is empty).
  React.useEffect(() => {
    if (!COLLAB_ENABLED) return;
    void editor.getApi(YjsPlugin).yjs.init({
      id: routeDocId,
      value: doc.content,
      autoConnect: true,
    });
    return () => {
      editor.getApi(YjsPlugin).yjs.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⌘S / Ctrl+S flushes a manual save.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveNow]);

  return (
    <Plate
      editor={editor}
      // With collab off, propagate content edits to the store so autosave
      // persists them. With collab on, Yjs owns content, so skip this.
      onChange={
        COLLAB_ENABLED ? undefined : ({ value }) => onContentChange(value)
      }
    >
      <div className="flex h-screen flex-col overflow-hidden">
        <EditorTopBar />
        <div className="flex min-h-0 flex-1">
          <EditorContainer className="h-full flex-1 bg-app-bg">
            <Editor
              variant="default"
              readOnly={readOnly}
              className="bg-document-surface"
            />
          </EditorContainer>
          {commentsOpen && <CommentsPanel />}
        </div>
      </div>
    </Plate>
  );
}

function LoadingShell() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-lg">
        <div className="size-7 rounded bg-surface-container" />
        <div className="h-5 w-48 animate-pulse rounded bg-surface-container" />
        <div className="ml-auto h-8 w-20 animate-pulse rounded bg-surface-container" />
      </header>
      <div className="flex-1 bg-app-bg">
        <div className="mx-auto mt-16 w-full max-w-2xl space-y-4 px-6">
          <div className="h-9 w-2/3 animate-pulse rounded bg-surface-container" />
          <div className="h-4 w-full animate-pulse rounded bg-surface-container" />
          <div className="h-4 w-11/12 animate-pulse rounded bg-surface-container" />
          <div className="h-4 w-4/5 animate-pulse rounded bg-surface-container" />
        </div>
      </div>
    </div>
  );
}
