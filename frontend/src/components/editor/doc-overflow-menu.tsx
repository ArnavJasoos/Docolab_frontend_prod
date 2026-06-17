"use client";

import * as React from "react";

import type { DocStatus } from "@/lib/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/icon";
import { useDocActions } from "@/components/editor/use-doc-actions";
import { useDocument } from "@/lib/store/document-store";

const STATUSES: DocStatus[] = ["Draft", "Working", "Pending Review", "Approved"];

function Row({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <>
      <Icon name={icon} size={18} className="text-text-muted" />
      <span className="flex-1">{children}</span>
    </>
  );
}

export function DocOverflowMenu() {
  const { status, setStatus, readOnly, setVersionsOpen } = useDocument();
  const a = useDocActions();

  return (
    <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="More document actions"
          className="flex size-8 items-center justify-center rounded-full text-on-surface-variant outline-none transition-colors hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary-container"
        >
          <Icon name="more_vert" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuItem onSelect={a.rename}>
            <Row icon="edit">Rename</Row>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void a.makeCopy()}>
            <Row icon="content_copy">Make a copy</Row>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setVersionsOpen(true)}>
            <Row icon="history">Version history</Row>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Row icon="label">Status: {status}</Row>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {STATUSES.map((s) => (
                <DropdownMenuItem key={s} onSelect={() => setStatus(s)}>
                  <span className="flex-1">{s}</span>
                  {s === status && <Icon name="check" size={16} />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Row icon="download">Download</Row>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={a.exportMarkdown}>
                <Row icon="description">Markdown (.md)</Row>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void a.exportPdf()}>
                <Row icon="picture_as_pdf">PDF (.pdf)</Row>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={a.print}>
                <Row icon="print">Print…</Row>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuItem onSelect={a.wordCount}>
            <Row icon="functions">Word count</Row>
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={a.toggleReadOnly}>
            <Row icon={readOnly ? "edit" : "visibility"}>
              {readOnly ? "Switch to editing" : "Read-only mode"}
            </Row>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem variant="destructive" onSelect={() => void a.moveToTrash()}>
            <Icon name="delete" size={18} />
            <span className="flex-1">Move to trash</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
    </DropdownMenu>
  );
}
