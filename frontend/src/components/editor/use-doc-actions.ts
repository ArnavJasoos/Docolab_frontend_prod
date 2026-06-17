"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useEditor } from "@/components/editor/editor-kit";
import { useDocument } from "@/lib/store/document-store";
import * as documents from "@/lib/api/documents";
import { downloadDocumentPdf } from "@/lib/pdf-export";

/** Custom event the title input listens for to enter rename mode. */
export const RENAME_EVENT = "docflow:rename";

/**
 * Centralised document-level actions shared by the menubar and the overflow
 * menu so both stay in sync.
 */
export function useDocActions() {
  const editor = useEditor();
  const router = useRouter();
  const { docId, title, readOnly, setReadOnly, saveNow } = useDocument();

  const focus = React.useCallback(() => editor.tf.focus(), [editor]);

  const exportMarkdown = React.useCallback(() => {
    let md = "";
    try {
      md = editor.api.markdown.serialize();
    } catch {
      md = editor.api.string([]);
    }
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title || "document"}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Exported as Markdown");
  }, [editor, title]);

  const print = React.useCallback(() => window.print(), []);

  const exportPdf = React.useCallback(async () => {
    const id = toast.loading("Generating PDF…");
    try {
      await downloadDocumentPdf(editor.children, title || "document");
      toast.success("Exported as PDF", { id });
    } catch {
      toast.error("Couldn't generate the PDF", { id });
    }
  }, [editor, title]);

  const wordCount = React.useCallback(() => {
    const text = editor.api.string([]) ?? "";
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    toast.message("Document statistics", {
      description: `${words} words · ${text.length} characters`,
    });
  }, [editor]);

  const rename = React.useCallback(() => {
    window.dispatchEvent(new CustomEvent(RENAME_EVENT));
  }, []);

  const makeCopy = React.useCallback(async () => {
    await saveNow();
    const copy = await documents.duplicateDocument(docId);
    toast.success("Copy created");
    router.push(`/editor?doc=${copy.id}`);
  }, [docId, router, saveNow]);

  const moveToTrash = React.useCallback(async () => {
    await documents.setTrashed(docId, true);
    toast.success("Moved to trash");
    router.push("/browser?filter=trash");
  }, [docId, router]);

  const toggleReadOnly = React.useCallback(() => {
    setReadOnly(!readOnly);
  }, [readOnly, setReadOnly]);

  return {
    focus,
    exportMarkdown,
    exportPdf,
    print,
    wordCount,
    rename,
    makeCopy,
    moveToTrash,
    toggleReadOnly,
    readOnly,
  };
}
