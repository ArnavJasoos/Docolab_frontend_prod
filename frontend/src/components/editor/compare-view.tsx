"use client";

import * as React from "react";
import { createSlateEditor, type Value } from "platejs";
import {
  Plate,
  PlateElement,
  PlateLeaf,
  createPlatePlugin,
  usePlateEditor,
  usePluginOption,
  type PlateElementProps,
  type PlateLeafProps,
} from "platejs/react";
import {
  computeDiff,
  defaultGetDeleteProps,
  defaultGetInsertProps,
  defaultGetUpdateProps,
} from "@platejs/diff";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { BaseEditorKit } from "@/components/editor/editor-base-kit";
import { aiAttributionPlugin } from "@/components/editor/plugins/ai-attribution-kit";
import { AI_EDIT_KEY } from "@/lib/ai-attribution";
import { getSnapshot, type DocSnapshot } from "@/lib/api/snapshots";
import * as documentsApi from "@/lib/api/documents";

type Side = "old" | "new";

// ---------------------------------------------------------------------------
// Diff render plugins. computeDiff annotates changed leaves/elements with
// `diff: true` + `diffOperation: { type }`. We render the SAME diff value in
// both panes; `side` decides whether a given change is shown (and how) or
// hidden, producing the classic left=old (red deletions) / right=new (green
// insertions) split. The `aiOn` option lets AI-attributed text override the
// red/green with blue (the feature-1 ↔ feature-2 conflict rule).
// ---------------------------------------------------------------------------

function DiffLeaf(props: PlateLeafProps) {
  const side = usePluginOption(compareDiffPlugin, "side") as Side;
  const aiOn = usePluginOption(compareDiffPlugin, "aiOn") as boolean;
  const leaf = props.leaf as Record<string, unknown>;
  const op = (leaf.diffOperation as { type?: string } | undefined)?.type;

  // Blue (AI) overrides red/green: defer styling so the aiEdit leaf renders blue.
  if (aiOn && leaf[AI_EDIT_KEY]) {
    return <PlateLeaf {...props}>{props.children}</PlateLeaf>;
  }

  if (op === "insert") {
    return (
      <PlateLeaf {...props}>
        <span
          className={cn(
            side === "new"
              ? "rounded-sm bg-insertion-bg text-insertion-text"
              : "hidden",
          )}
        >
          {props.children}
        </span>
      </PlateLeaf>
    );
  }

  if (op === "delete") {
    return (
      <PlateLeaf {...props}>
        <span
          className={cn(
            side === "old"
              ? "rounded-sm bg-deletion-bg text-deletion-text line-through"
              : "hidden",
          )}
        >
          {props.children}
        </span>
      </PlateLeaf>
    );
  }

  return <PlateLeaf {...props}>{props.children}</PlateLeaf>;
}

function DiffBlock(props: PlateElementProps) {
  const side = usePluginOption(compareDiffPlugin, "side") as Side;
  const element = props.element as Record<string, unknown>;
  const op = (element.diffOperation as { type?: string } | undefined)?.type;

  if (op === "insert" && side === "old") {
    return <PlateElement {...props} className="hidden" />;
  }
  if (op === "delete" && side === "new") {
    return <PlateElement {...props} className="hidden" />;
  }
  if (op === "insert") {
    return (
      <PlateElement
        {...props}
        className="border-l-2 border-insertion-text/60 bg-insertion-bg/40 pl-2"
      />
    );
  }
  if (op === "delete") {
    return (
      <PlateElement
        {...props}
        className="border-l-2 border-deletion-text/60 bg-deletion-bg/40 pl-2"
      />
    );
  }
  return <PlateElement {...props} />;
}

// Single source of side/aiOn options; DiffBlock reads them off this plugin too.
const compareDiffPlugin = createPlatePlugin({
  key: "diff",
  node: { isLeaf: true },
  options: { side: "new" as Side, aiOn: false },
}).withComponent(DiffLeaf);

const compareDiffBlockPlugin = createPlatePlugin({
  key: "diffBlock",
}).configure({
  render: { aboveNodes: () => (p) => <DiffBlock {...p} /> },
});

function ComparePane({
  diffValue,
  side,
  aiOn,
  scrollRef,
  onScroll,
}: {
  diffValue: Value;
  side: Side;
  aiOn: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: (from: Side) => void;
}) {
  // Each editor must own its node objects — Slate mutates value in place, so the
  // two panes cannot share the same diff nodes (causes "Unable to find path").
  const paneValue = React.useMemo(
    () => structuredClone(diffValue),
    [diffValue],
  );

  const editor = usePlateEditor(
    {
      plugins: [
        ...BaseEditorKit,
        aiAttributionPlugin,
        compareDiffPlugin.configure({ options: { side, aiOn } }),
        compareDiffBlockPlugin,
      ],
      value: paneValue,
    },
    [],
  );

  // Keep the AI-override toggle live without re-creating the editor.
  React.useEffect(() => {
    editor.setOption(compareDiffPlugin, "aiOn", aiOn);
    editor.setOption(aiAttributionPlugin, "show", aiOn);
  }, [editor, aiOn]);

  return (
    <div
      ref={scrollRef}
      onScroll={() => onScroll(side)}
      className="h-full flex-1 overflow-y-auto bg-document-surface"
    >
      <Plate editor={editor}>
        <EditorContainer>
          <Editor variant="default" readOnly className="bg-document-surface" />
        </EditorContainer>
      </Plate>
    </div>
  );
}

export function CompareView({
  docId,
  snapshotId,
  onClose,
}: {
  docId: string;
  snapshotId: string;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = React.useState<DocSnapshot | null>(null);
  const [diffValue, setDiffValue] = React.useState<Value | null>(null);
  const [aiOn, setAiOn] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  const leftRef = React.useRef<HTMLDivElement | null>(null);
  const rightRef = React.useRef<HTMLDivElement | null>(null);
  const syncing = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [snap, current] = await Promise.all([
        getSnapshot(docId, snapshotId),
        documentsApi.getDocument(docId),
      ]);
      if (cancelled) return;
      if (!snap || !current) {
        setLoading(false);
        return;
      }
      // Diff old → current. aiEdit/comment marks are ignored so they don't
      // register as textual changes (they're rendered separately).
      const base = createSlateEditor({ plugins: BaseEditorKit });
      const value = computeDiff(snap.value, current.content, {
        isInline: base.api.isInline,
        getInsertProps: defaultGetInsertProps,
        getDeleteProps: defaultGetDeleteProps,
        getUpdateProps: defaultGetUpdateProps,
        ignoreProps: [AI_EDIT_KEY],
      });
      setSnapshot(snap);
      setDiffValue(value as Value);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, snapshotId]);

  // Ratio-based synced scrolling (block heights differ between versions).
  const onScroll = React.useCallback((from: Side) => {
    if (syncing.current) {
      syncing.current = false;
      return;
    }
    const src = from === "old" ? leftRef.current : rightRef.current;
    const dst = from === "old" ? rightRef.current : leftRef.current;
    if (!src || !dst) return;
    const max = src.scrollHeight - src.clientHeight;
    const ratio = max > 0 ? src.scrollTop / max : 0;
    syncing.current = true;
    dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-app-bg text-text-primary">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-lg">
        <div className="flex items-center gap-2">
          <Icon name="difference" className="text-[22px] text-primary-container" />
          <span className="font-ui-lg text-ui-lg font-semibold text-text-primary">
            Compare documents
          </span>
          {snapshot && (
            <span className="font-ui-sm text-ui-sm text-text-secondary">
              {snapshot.label} → Current
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Legend */}
          <div className="hidden items-center gap-3 font-ui-xs text-ui-xs text-text-secondary sm:flex">
            <span className="flex items-center gap-1">
              <span className="size-3 rounded-sm bg-deletion-bg" /> Removed
            </span>
            <span className="flex items-center gap-1">
              <span className="size-3 rounded-sm bg-insertion-bg" /> Added
            </span>
            <span className="flex items-center gap-1">
              <span className="size-3 rounded-sm bg-primary-container/30" /> AI
            </span>
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1 font-ui-sm text-ui-sm text-text-primary">
            <input
              type="checkbox"
              checked={aiOn}
              onChange={(e) => setAiOn(e.target.checked)}
              className="size-3.5 rounded border-border-subtle text-primary-container focus:ring-primary-container"
            />
            Show AI edits
          </label>
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-md bg-primary-container px-3 py-1.5 font-ui-sm text-ui-sm font-semibold text-on-primary transition-colors hover:bg-accent-hover"
          >
            <Icon name="close" size={16} />
            Close
          </button>
        </div>
      </header>

      {/* Pane headers */}
      <div className="flex shrink-0 border-b border-border-subtle bg-panel-surface font-ui-sm text-ui-sm font-semibold text-text-secondary">
        <div className="flex-1 border-r border-border-subtle px-lg py-2">
          {snapshot ? snapshot.label : "Older version"}
          <span className="ml-2 font-normal text-text-muted">(older)</span>
        </div>
        <div className="flex-1 px-lg py-2">
          Current version
          <span className="ml-2 font-normal text-text-muted">(latest)</span>
        </div>
      </div>

      {/* Panes */}
      <div className="flex min-h-0 flex-1">
        {loading || !diffValue ? (
          <div className="flex flex-1 items-center justify-center text-text-muted">
            <Icon name="progress_activity" className="animate-spin text-[28px]" />
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 border-r border-border-subtle">
              <ComparePane
                diffValue={diffValue}
                side="old"
                aiOn={aiOn}
                scrollRef={leftRef}
                onScroll={onScroll}
              />
            </div>
            <div className="flex min-w-0 flex-1">
              <ComparePane
                diffValue={diffValue}
                side="new"
                aiOn={aiOn}
                scrollRef={rightRef}
                onScroll={onScroll}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
