// =============================================================================
// app/api/ai/models/route.ts
//
// Reports the AI model the signed-in user's editor will use, for display in the
// Ask-AI popup. Proxies the backend's GET /ai/models, forwarding the caller's
// token so the backend resolves THEIR admin-assigned model.
//
// Read-only by design: which model a user gets is an admin decision (Admin >
// Users > AI Model), so the popup shows the assignment rather than a picker.
// =============================================================================

import type { NextRequest } from 'next/server';

import { NextResponse } from 'next/server';

const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api'
).replace(/\/+$/, '');

export async function GET(req: NextRequest) {
  const authorization = req.headers.get('authorization');

  if (!authorization) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  try {
    const res = await fetch(`${API_URL}/ai/models`, {
      cache: 'no-store',
      headers: { Authorization: authorization },
    });

    if (!res.ok) {
      // 409 = the org has no enabled model; surface the reason so the popup can
      // tell the user to ask an admin rather than failing silently.
      const body = await res.json().catch(() => null);

      return NextResponse.json(
        {
          error:
            typeof body?.detail === 'string'
              ? body.detail
              : 'AI model unavailable',
        },
        { status: res.status }
      );
    }

    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'Backend unreachable' }, { status: 502 });
  }
}
