// =============================================================================
// lib/pdf-export.ts
// Real PDF generation from a Plate/Slate document value using pdf-lib.
//
// Unlike the old "screenshot the page" approach, this walks the document tree
// and lays out actual text runs (with bold/italic/underline/code), headings,
// lists, blockquotes, horizontal rules, tables, and embedded images. Output is
// selectable, searchable text — not a flat bitmap.
// =============================================================================

import {
  PDFDocument,
  PDFFont,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { Value } from "platejs";

type RichNode = {
  type?: string;
  text?: string;
  url?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  listStyleType?: string;
  indent?: number;
  children?: RichNode[];
};

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait, points
const MARGIN = 56;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const INK = rgb(0.06, 0.09, 0.16); // ~ text-primary
const MUTED = rgb(0.4, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

const HEADING_SIZE: Record<string, number> = { h1: 22, h2: 17, h3: 14 };

function nodeText(node: RichNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.children ?? []).map(nodeText).join("");
}

/** A drawing cursor that paginates as content overflows. */
class Cursor {
  doc: PDFDocument;
  fonts: Fonts;
  page = null as ReturnType<PDFDocument["addPage"]> | null;
  y = 0;

  constructor(doc: PDFDocument, fonts: Fonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
  }

  ensure(space: number) {
    if (this.y - space < MARGIN) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
    if (this.y < MARGIN) this.newPage();
  }
}

function pickFont(fonts: Fonts, run: RichNode): PDFFont {
  if (run.code) return fonts.mono;
  if (run.bold && run.italic) return fonts.boldItalic;
  if (run.bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

/** Lay out a sequence of styled text runs with word-wrapping + pagination. */
function drawRuns(
  cur: Cursor,
  runs: RichNode[],
  opts: {
    size: number;
    x: number;
    maxWidth: number;
    color?: ReturnType<typeof rgb>;
    lineHeight?: number;
    forceFont?: PDFFont;
  },
) {
  const { size, x, maxWidth } = opts;
  const color = opts.color ?? INK;
  const lineHeight = opts.lineHeight ?? size * 1.45;

  // Tokenize into {text, font} words preserving spaces.
  type Word = { text: string; font: PDFFont; underline: boolean };
  const words: Word[] = [];
  for (const run of runs) {
    const font = opts.forceFont ?? pickFont(cur.fonts, run);
    const parts = (run.text ?? "").split(/(\s+)/).filter((p) => p !== "");
    for (const p of parts) words.push({ text: p, font, underline: !!run.underline });
  }
  if (words.length === 0) return;

  let line: Word[] = [];
  let lineWidth = 0;

  const flush = () => {
    cur.ensure(lineHeight);
    let dx = x;
    const baseY = cur.y - size;
    for (const w of line) {
      const ww = w.font.widthOfTextAtSize(w.text, size);
      cur.page!.drawText(w.text, { x: dx, y: baseY, size, font: w.font, color });
      if (w.underline && w.text.trim()) {
        cur.page!.drawLine({
          start: { x: dx, y: baseY - 1.5 },
          end: { x: dx + ww, y: baseY - 1.5 },
          thickness: 0.5,
          color,
        });
      }
      dx += ww;
    }
    cur.y -= lineHeight;
    line = [];
    lineWidth = 0;
  };

  for (const w of words) {
    const ww = w.font.widthOfTextAtSize(w.text, size);
    if (lineWidth + ww > maxWidth && line.length > 0 && w.text.trim()) {
      flush();
    }
    line.push(w);
    lineWidth += ww;
  }
  if (line.length) flush();
}

async function drawImage(cur: Cursor, url: string) {
  try {
    const res = await fetch(url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ct = res.headers.get("content-type") ?? "";
    const img = ct.includes("png") || url.toLowerCase().endsWith(".png")
      ? await cur.doc.embedPng(bytes)
      : await cur.doc.embedJpg(bytes);
    const scale = Math.min(1, CONTENT_WIDTH / img.width);
    const w = img.width * scale;
    const h = img.height * scale;
    cur.ensure(h + 12);
    cur.page!.drawImage(img, { x: MARGIN, y: cur.y - h, width: w, height: h });
    cur.gap(h + 12);
  } catch {
    drawRuns(cur, [{ text: `🖼  ${url}` }], { size: 10, x: MARGIN, maxWidth: CONTENT_WIDTH, color: MUTED });
    cur.gap(6);
  }
}

function drawTable(cur: Cursor, table: RichNode) {
  const rows = (table.children ?? []).filter((r) => r.type === "tr");
  for (const row of rows) {
    const cells = (row.children ?? []).filter((c) => c.type === "td" || c.type === "th");
    const cellWidth = CONTENT_WIDTH / Math.max(1, cells.length);
    const rowTop = cur.y;
    let maxDrop = 0;
    cells.forEach((cell, i) => {
      const saved = cur.y;
      cur.y = rowTop;
      drawRuns(cur, [{ text: nodeText(cell) }], {
        size: 10,
        x: MARGIN + i * cellWidth + 4,
        maxWidth: cellWidth - 8,
      });
      maxDrop = Math.max(maxDrop, rowTop - cur.y);
      if (i < cells.length - 1) cur.y = saved;
    });
    cur.y = rowTop - Math.max(maxDrop, 16) - 4;
    cur.page!.drawLine({
      start: { x: MARGIN, y: cur.y + 2 },
      end: { x: PAGE.width - MARGIN, y: cur.y + 2 },
      thickness: 0.5,
      color: RULE,
    });
  }
  cur.gap(8);
}

function blockSpacingBefore(type?: string): number {
  if (type === "h1") return 16;
  if (type === "h2") return 14;
  if (type === "h3") return 10;
  return 6;
}

/** Render a Slate document value into PDF bytes. */
export async function renderDocumentPdf(value: Value, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title || "Document");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const cur = new Cursor(doc, fonts);

  const blocks = (value as RichNode[]) ?? [];
  for (const block of blocks) {
    const type = block.type ?? "p";
    const runs = (block.children ?? []) as RichNode[];

    if (type === "hr") {
      cur.gap(8);
      cur.ensure(8);
      cur.page!.drawLine({
        start: { x: MARGIN, y: cur.y },
        end: { x: PAGE.width - MARGIN, y: cur.y },
        thickness: 1,
        color: RULE,
      });
      cur.gap(10);
      continue;
    }

    if (type === "img" || block.url) {
      const url = block.url ?? "";
      if (url) await drawImage(cur, url);
      const cap = nodeText(block).trim();
      if (cap) {
        drawRuns(cur, [{ text: cap }], { size: 9, x: MARGIN, maxWidth: CONTENT_WIDTH, color: MUTED, lineHeight: 12 });
        cur.gap(8);
      }
      continue;
    }

    if (type === "table") {
      cur.gap(blockSpacingBefore(type));
      drawTable(cur, block);
      continue;
    }

    cur.gap(blockSpacingBefore(type));

    if (type in HEADING_SIZE) {
      drawRuns(cur, runs, { size: HEADING_SIZE[type], x: MARGIN, maxWidth: CONTENT_WIDTH, forceFont: fonts.bold });
      cur.gap(2);
      continue;
    }

    if (type === "blockquote") {
      const x = MARGIN + 14;
      const top = cur.y;
      drawRuns(cur, runs, { size: 11, x, maxWidth: CONTENT_WIDTH - 14, color: MUTED, forceFont: fonts.italic });
      cur.page!.drawRectangle({ x: MARGIN, y: cur.y, width: 3, height: top - cur.y, color: RULE });
      cur.gap(4);
      continue;
    }

    // List items: a paragraph carrying listStyleType (Plate's indent-list model).
    if (block.listStyleType) {
      const indent = (block.indent ?? 1) * 16;
      const bullet = block.listStyleType === "decimal" ? "•" : "•";
      cur.ensure(16);
      cur.page!.drawText(bullet, {
        x: MARGIN + indent - 12,
        y: cur.y - 11,
        size: 11,
        font: fonts.regular,
        color: INK,
      });
      drawRuns(cur, runs, { size: 11, x: MARGIN + indent, maxWidth: CONTENT_WIDTH - indent });
      continue;
    }

    // Default paragraph.
    drawRuns(cur, runs, { size: 11, x: MARGIN, maxWidth: CONTENT_WIDTH });
  }

  return doc.save();
}

/** Render + trigger a browser download. */
export async function downloadDocumentPdf(value: Value, title: string): Promise<void> {
  const bytes = await renderDocumentPdf(value, title);
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${title || "document"}.pdf`;
  a.click();
  URL.revokeObjectURL(a.href);
}
