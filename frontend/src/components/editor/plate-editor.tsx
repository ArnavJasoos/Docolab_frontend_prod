"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { Plate, usePlateEditor, usePluginOption } from "platejs/react";
import { YjsPlugin } from "@platejs/yjs/react";

import type { DocumentRecord } from "@/lib/types";
import { EditorKit } from "@/components/editor/editor-kit";
import { createYjsPlugin } from "@/components/editor/plugins/yjs-kit";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { EditorTopBar } from "@/components/editor/editor-top-bar";
import { getCurrentUser } from "@/lib/api/auth";
import { buildCursorIdentity } from "@/lib/presence-identity";

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

function LoadedWorkspace({ doc, routeDocId }: { doc: DocumentRecord; routeDocId: string }) {
  // Real-time collaboration is always on: content is owned by Yjs/Hocuspocus
  // (the canonical, persisted path) and the REST `content` is only the seed used
  // when a document's shared Y.Doc is still empty.
  //
  // The Hocuspocus room is the canonical document id from the route (the real
  // backend UUID), NOT the local metadata record id — they coincide once the
  // document store talks to the real API, but the route id is authoritative for
  // collaboration so two clients on the same URL share a room.
  const cursorData = React.useMemo(() => {
    const me = getCurrentUser();
    return buildCursorIdentity(
      me ?? { id: "anonymous", name: "Anonymous", email: "" },
    );
  }, []);

  const editor = usePlateEditor({
    // Yjs owns initialization — skip Plate's value seeding and init the shared
    // doc in the effect below (which seeds from the REST content only when the
    // shared doc is empty).
    skipInitialization: true,
    plugins: React.useMemo(
      () => [...EditorKit, createYjsPlugin(routeDocId, cursorData)],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  });
  const { readOnly, commentsOpen, saveNow } = useDocument();

  // Connect to Hocuspocus and seed the shared Y.Doc. On the very first connect
  // for a document (yjs_state is NULL server-side) the shared doc is empty, so
  // we seed it from the REST `content` we already loaded. Once content lives in
  // Yjs, that seed is ignored (init only seeds when the shared doc is empty).
  React.useEffect(() => {
    void editor.getApi(YjsPlugin).yjs.init({
      id: routeDocId,
      value: doc.content,
      autoConnect: true,
    });
    // Publish the local user's presence identity immediately (before the first
    // cursor move) so the avatar stack shows this user as soon as they join.
    try {
      editor.getOptions(YjsPlugin).awareness?.setLocalStateField("data", cursorData);
    } catch {
      /* awareness not ready yet — autoSend will publish on first selection */
    }
    return () => {
      editor.getApi(YjsPlugin).yjs.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⌘S / Ctrl+S flushes a manual save (title/status metadata; content is Yjs).
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
    <Plate editor={editor}>
      <CollabStatus />
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

// Surfaces the live Hocuspocus connection state as a non-intrusive toast: a
// sticky "reconnecting" warning while the socket is down (only after we were
// connected at least once), cleared when the link comes back. Must render
// inside <Plate> so it can read the YjsPlugin option.
function CollabStatus() {
  const isConnected = usePluginOption(YjsPlugin, "_isConnected");
  const wasConnected = React.useRef(false);

  React.useEffect(() => {
    if (isConnected) {
      if (wasConnected.current) {
        toast.success("Reconnected", { id: "collab-conn", duration: 2000 });
      }
      wasConnected.current = true;
    } else if (wasConnected.current) {
      toast.warning("Connection lost — reconnecting…", {
        id: "collab-conn",
        duration: Infinity,
      });
    }
  }, [isConnected]);

  return null;
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
