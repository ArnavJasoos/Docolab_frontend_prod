// =============================================================================
// lib/api/ai.ts
// Frontend client for the AI Suggestion cluster.
// Maps to backend api/ai.py (mounted at the bare /api prefix).
//
// Backend routes (canonical, after the prefix fix):
//   POST /documents/:id/ai/suggest
//   POST /recommendations/:id/ai/apply
//   GET  /ai/jobs/:job_id
//
// All AI work is async: enqueue a job, then poll getJob() until it completes.
// =============================================================================

import { apiFetch } from "./client";

export interface AIJob {
  job_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  created_at?: string;
  completed_at?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/** Enqueue an AI job to draft suggestions for a document. */
export async function suggest(docId: string) {
  return apiFetch<{ job_id: string; status: string; message: string }>(
    `/documents/${docId}/ai/suggest`,
    { method: "POST", body: "{}" },
  );
}

/** Enqueue an AI job to draft suggestions for a recommendation. */
export async function applyToRecommendation(recommendationId: string) {
  return apiFetch<{ job_id: string; status: string; message: string }>(
    `/recommendations/${recommendationId}/ai/apply`,
    { method: "POST", body: "{}" },
  );
}

/** Poll the status (and eventual result) of an AI job. */
export async function getJob(jobId: string): Promise<AIJob> {
  return apiFetch<AIJob>(`/ai/jobs/${jobId}`);
}
