"use client";

import * as React from "react";
import dynamic from "next/dynamic";
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
import { getDiscussions } from "@/lib/api/comments";
import { getToken } from "@/lib/api/client";

export function PlateEditor({ docId }: { docId: string }) {
  return (
    <DocumentProvider docId={docId}>
      <Workspace />
    </DocumentProvider>
  );
}

function Workspace() {
  const { doc, loading } = useDocument();

  if (loading || !doc) return <LoadingShell />;
  // Re-mount the Plate editor when the underlying document changes.
  return <LoadedWorkspace key={doc.id} doc={doc} />;
}

function LoadedWorkspace({ doc }: { doc: DocumentRecord }) {
  const token = getToken() ?? "";
  // The editor is re-mounted per doc.id (key in <Workspace>), so building the
  // plugin list once on mount is correct — docId/token never change in-place.
  const editor = usePlateEditor({
    // Yjs owns initialization: skip Plate's normal value seeding and init the
    // shared doc manually in the effect below (Plate Yjs requirement).
    skipInitialization: true,
    plugins: React.useMemo(
      () => [...EditorKit, createYjsPlugin(doc.id, token)],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  });
  const { docId, readOnly, commentsOpen, saveNow } = useDocument();

  // Connect to Hocuspocus and seed the shared Y.Doc. On the very first connect
  // for a document (yjs_state is NULL server-side) the shared doc is empty, so
  // we seed it from the REST `content` we already loaded. Once content lives in
  // Yjs, that seed is ignored (init only seeds when the shared doc is empty).
  React.useEffect(() => {
    void editor.getApi(YjsPlugin).yjs.init({
      id: doc.id,
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
    <Plate editor={editor}>
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
