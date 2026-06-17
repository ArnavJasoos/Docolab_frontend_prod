"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KEYS } from "platejs";

import { useEditor } from "@/components/editor/editor-kit";
import { useDocActions } from "@/components/editor/use-doc-actions";
import { useDocument } from "@/lib/store/document-store";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "@/components/ui/menubar";

const triggerCls =
  "px-3 py-1 h-auto font-ui-sm text-ui-sm text-on-surface-variant rounded data-[state=open]:bg-surface-container hover:bg-surface-container";

export function DocMenubar() {
  const editor = useEditor();
  const router = useRouter();
  const a = useDocActions();
  const {
    readOnly,
    setReadOnly,
    commentsOpen,
    setCommentsOpen,
    setShareOpen,
    setVersionsOpen,
    saveNow,
  } = useDocument();

  const focus = () => editor.tf.focus();

  const insertImage = () => {
    const url = window.prompt("Image URL");
    if (!url) return;
    focus();
    editor.tf.insertNodes({ type: KEYS.img, url, children: [{ text: "" }] });
  };

  const insertLink = () => {
    const url = window.prompt("Link URL");
    if (!url) return;
    focus();
    editor.tf.insertNodes({ type: KEYS.link, url, children: [{ text: url }] });
  };

  const insertTable = () => {
    focus();
    const cell = () => ({
      type: KEYS.td,
      children: [{ type: KEYS.p, children: [{ text: "" }] }],
    });
    const row = () => ({ type: KEYS.tr, children: [cell(), cell(), cell()] });
    editor.tf.insertNodes({ type: KEYS.table, children: [row(), row(), row()] });
  };

  const insertHr = () => {
    focus();
    editor.tf.insertNodes({ type: KEYS.hr, children: [{ text: "" }] });
  };

  const insertDate = () => {
    focus();
    editor.tf.insertNodes({
      type: KEYS.date,
      date: new Date().toISOString().split("T")[0],
      children: [{ text: "" }],
    });
  };

  const selectAll = () => {
    focus();
    editor.tf.select({
      anchor: editor.api.start([])!,
      focus: editor.api.end([])!,
    });
  };

  return (
    <Menubar className="flex h-auto gap-0 border-none bg-transparent p-0 shadow-none">
      {/* File */}
      <MenubarMenu>
        <MenubarTrigger className={triggerCls}>File</MenubarTrigger>
        <MenubarContent align="start">
          <MenubarItem onSelect={() => router.push("/editor")}>New document</MenubarItem>
          <MenubarItem onSelect={() => router.push("/browser")}>Open…</MenubarItem>
          <MenubarItem onSelect={() => void saveNow()}>
            Save<MenubarShortcut>⌘S</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => void a.makeCopy()}>Make a copy</MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={a.exportMarkdown}>Export as Markdown</MenubarItem>
          <MenubarItem onSelect={() => void a.exportPdf()}>Export as PDF</MenubarItem>
          <MenubarItem onSelect={a.print}>
            Print<MenubarShortcut>⌘P</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => setVersionsOpen(true)}>Version history</MenubarItem>
          <MenubarItem onSelect={() => void a.moveToTrash()}>Move to trash</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      {/* Edit */}
      <MenubarMenu>
        <MenubarTrigger className={triggerCls}>Edit</MenubarTrigger>
        <MenubarContent align="start">
          <MenubarItem onSelect={() => editor.tf.undo()}>
            Undo<MenubarShortcut>⌘Z</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => editor.tf.redo()}>
            Redo<MenubarShortcut>⌘⇧Z</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={selectAll}>
            Select all<MenubarShortcut>⌘A</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={a.rename}>Rename document</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      {/* View */}
      <MenubarMenu>
        <MenubarTrigger className={triggerCls}>View</MenubarTrigger>
        <MenubarContent align="start">
          <MenubarItem onSelect={() => setReadOnly(!readOnly)}>
            {readOnly ? "Switch to editing" : "Read-only mode"}
          </MenubarItem>
          <MenubarItem onSelect={() => setCommentsOpen(!commentsOpen)}>
            {commentsOpen ? "Hide comments" : "Show comments"}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      {/* Insert */}
      <MenubarMenu>
        <MenubarTrigger className={triggerCls}>Insert</MenubarTrigger>
        <MenubarContent align="start">
          <MenubarItem onSelect={insertTable}>Table</MenubarItem>
          <MenubarItem onSelect={insertImage}>Image…</MenubarItem>
          <MenubarItem onSelect={insertLink}>Link…</MenubarItem>
          <MenubarItem onSelect={insertHr}>Horizontal rule</MenubarItem>
          <MenubarItem onSelect={insertDate}>Date</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      {/* Format */}
      <MenubarMenu>
        <MenubarTrigger className={triggerCls}>Format</MenubarTrigger>
        <MenubarContent align="start">
          <MenubarItem onSelect={() => { focus(); editor.tf.bold.toggle(); }}>
            Bold<MenubarShortcut>⌘B</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => { focus(); editor.tf.italic.toggle(); }}>
            Italic<MenubarShortcut>⌘I</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => { focus(); editor.tf.underline.toggle(); }}>
            Underline<MenubarShortcut>⌘U</MenubarShortcut>
          </MenubarItem>
          <MenubarItem onSelect={() => { focus(); editor.tf.strikethrough.toggle(); }}>
            Strikethrough
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => { focus(); editor.tf.h1.toggle(); }}>Heading 1</MenubarItem>
          <MenubarItem onSelect={() => { focus(); editor.tf.h2.toggle(); }}>Heading 2</MenubarItem>
          <MenubarItem onSelect={() => { focus(); editor.tf.h3.toggle(); }}>Heading 3</MenubarItem>
          <MenubarItem onSelect={() => { focus(); editor.tf.blockquote.toggle(); }}>
            Blockquote
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      {/* Tools */}
      <MenubarMenu>
        <MenubarTrigger className={triggerCls}>Tools</MenubarTrigger>
        <MenubarContent align="start">
          <MenubarItem onSelect={a.wordCount}>Word count</MenubarItem>
          <MenubarItem onSelect={() => setShareOpen(true)}>Share…</MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={() => setReadOnly(!readOnly)}>
            {readOnly ? "Disable read-only" : "Enable read-only"}
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
