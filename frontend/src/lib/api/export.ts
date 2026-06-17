// =============================================================================
// lib/api/export.ts
// Frontend client for the Export cluster.
// Maps to backend api/export.py (mounted at the bare /api prefix).
//
// Backend routes (canonical, after the prefix fix):
//   GET /documents/:id/export?format=md|docx
//   GET /versions/:id/export?format=md|docx
// =============================================================================

import { apiFetch } from "./client";

export type ExportFormat = "md" | "docx";

export interface ExportResult {
  document_id: string;
  version_no?: number;
  format: ExportFormat;
  content: string;
  file_name: string;
}

/** Render the current live document to Markdown or Word. */
export async function exportDocument(docId: string, format: ExportFormat = "md") {
  return apiFetch<ExportResult>(`/documents/${docId}/export?format=${format}`);
}

/** Render a specific approved version to Markdown or Word. */
export async function exportVersion(versionId: string, format: ExportFormat = "md") {
  return apiFetch<ExportResult>(`/versions/${versionId}/export?format=${format}`);
}

/**
 * Convenience: trigger a browser download of an exported document.
 * Wraps exportDocument() and saves the returned content as a file.
 */
export async function downloadDocument(docId: string, format: ExportFormat = "md") {
  const { content, file_name } = await exportDocument(docId, format);
  const mime = format === "md" ? "text/markdown" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file_name || `document.${format}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
