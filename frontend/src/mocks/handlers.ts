// =============================================================================
// src/mocks/handlers.ts
// MSW request handlers — the LOCKED frontend↔backend contract.
//
// Response shapes mirror the FastAPI backend schemas exactly (see
// INTEGRATION_CHANGES.md and backend/app/schemas/*). This lets the frontend
// build and test with zero backend until Postgres access is available.
//
// Base URL matches lib/api/client.ts (NEXT_PUBLIC_API_URL or :8000/api).
// =============================================================================

import { http, HttpResponse } from "msw";

const BASE =
  (process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000/api");

const url = (path: string) => `${BASE}${path}`;

// --- stable fixtures (deterministic so tests can assert on them) -------------
const MOCK_USER = {
  id: "00000000-0000-0000-0000-0000000000aa",
  email: "you@docflow.test",
  display_name: "You",
  avatar_color: "#7aa2f7",
  status: "active",
  created_at: "2026-06-01T10:00:00Z",
};
const MOCK_TOKEN = "mock.jwt.token";

const mockVersion = (no: number, kind: "submission" | "approved") => ({
  id: `ver-${no}`,
  document_id: "doc-1",
  version_no: no,
  kind,
  created_by: MOCK_USER.id,
  created_at: new Date(Date.now() - no * 3_600_000).toISOString(),
  s3_key: `versions/doc-1/v${no}`,
});

export const handlers = [
  // ---- Auth -----------------------------------------------------------------
  http.post(url("/auth/signup"), async ({ request }) => {
    const body = (await request.json()) as { email?: string; display_name?: string };
    return HttpResponse.json(
      { user: { ...MOCK_USER, email: body.email ?? MOCK_USER.email, display_name: body.display_name ?? MOCK_USER.display_name }, token: MOCK_TOKEN },
      { status: 201 },
    );
  }),
  http.post(url("/auth/login"), async ({ request }) => {
    const body = (await request.json()) as { email?: string };
    return HttpResponse.json({ user: { ...MOCK_USER, email: body.email ?? MOCK_USER.email }, token: MOCK_TOKEN });
  }),
  http.get(url("/auth/me"), () => HttpResponse.json(MOCK_USER)),

  // ---- Versions & approval --------------------------------------------------
  http.get(url("/documents/:id/versions"), () =>
    HttpResponse.json({
      versions: [
        mockVersion(3, "submission"),
        mockVersion(2, "approved"),
        mockVersion(1, "approved"),
      ],
    }),
  ),
  http.get(url("/versions/:id"), ({ params }) =>
    HttpResponse.json({
      id: String(params.id),
      document_id: "doc-1",
      version_no: 2,
      kind: "approved",
      created_by: MOCK_USER.id,
      created_at: "2026-06-10T12:00:00Z",
      s3_url: `https://signed-url.test/versions/${params.id}`,
    }),
  ),
  http.post(url("/documents/:id/submit-for-approval"), () =>
    HttpResponse.json({ version_id: "ver-4", version_no: 4, message: "Submitted for approval (version 4)" }),
  ),
  http.get(url("/documents/:id/diff"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    return HttpResponse.json({
      from_version_no: Number(q.get("from") ?? 1),
      to_version_no: Number(q.get("to") ?? 2),
      diff_content: { from_s3_key: "versions/doc-1/v1", to_s3_key: "versions/doc-1/v2", message: "mock diff" },
    });
  }),
  http.post(url("/versions/:id/approve"), ({ params }) =>
    HttpResponse.json({ success: true, message: `Version ${params.id} approved` }),
  ),
  http.post(url("/versions/:id/reject"), ({ params }) =>
    HttpResponse.json({ success: true, message: `Version ${params.id} rejected` }),
  ),
  http.post(url("/versions/:id/restore"), ({ params }) =>
    HttpResponse.json({ success: true, message: `Section restored in version ${params.id}` }),
  ),

  // ---- Notifications --------------------------------------------------------
  http.get(url("/notifications"), () =>
    HttpResponse.json({
      notifications: [
        {
          id: "notif-1",
          user_id: MOCK_USER.id,
          document_id: "doc-1",
          type: "submission_pending",
          payload: { version_id: "ver-3", version_no: 3, submitter: MOCK_USER.id },
          delivered: false,
          created_at: "2026-06-15T09:00:00Z",
          read_at: null,
        },
      ],
    }),
  ),
  http.post(url("/notifications/:id/read"), () =>
    HttpResponse.json({ success: true, message: "Notification marked as read" }),
  ),
  http.post(url("/notifications/read-all"), () =>
    HttpResponse.json({ success: true, message: "All notifications marked as read", count: 1 }),
  ),

  // ---- AI -------------------------------------------------------------------
  http.post(url("/documents/:id/ai/suggest"), () =>
    HttpResponse.json({ job_id: "job-1", status: "pending", message: "AI suggestion job enqueued" }),
  ),
  http.post(url("/recommendations/:id/ai/apply"), () =>
    HttpResponse.json({ job_id: "job-2", status: "pending", message: "AI drafting suggestions for recommendation" }),
  ),
  http.get(url("/ai/jobs/:job_id"), ({ params }) =>
    HttpResponse.json({
      job_id: String(params.job_id),
      status: "completed",
      created_at: "2026-06-15T09:00:00Z",
      completed_at: "2026-06-15T09:00:05Z",
      result: { suggestions_created: 1, message: "Job completed successfully" },
      error: null,
    }),
  ),

  // ---- Export ---------------------------------------------------------------
  http.get(url("/documents/:id/export"), ({ request }) => {
    const format = new URL(request.url).searchParams.get("format") ?? "md";
    return HttpResponse.json({
      document_id: "doc-1",
      version_no: null,
      format,
      content: "# Mock Document\n\nExported content.",
      file_name: `document.${format}`,
    });
  }),
  http.get(url("/versions/:id/export"), ({ request, params }) => {
    const format = new URL(request.url).searchParams.get("format") ?? "md";
    return HttpResponse.json({
      document_id: "doc-1",
      version_no: 2,
      format,
      content: `# Mock Version ${params.id}\n\nExported content.`,
      file_name: `document_v2.${format}`,
    });
  }),
];
