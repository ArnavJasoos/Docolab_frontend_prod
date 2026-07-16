// =============================================================================
// app/api/ai/models/route.ts
//
// Model catalog for the Ask-AI popup's model picker. Proxies the Ask-AI
// service's GET /health (which reports default_model + available_models from
// its config.yaml) so the browser never talks to the service directly.
// =============================================================================

import { NextResponse } from 'next/server';

const ASK_AI_URL = (process.env.ASK_AI_URL || 'http://localhost:8001').replace(
  /\/+$/,
  ''
);

export async function GET() {
  try {
    const res = await fetch(`${ASK_AI_URL}/health`, { cache: 'no-store' });

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Ask-AI service unavailable' },
        { status: 502 }
      );
    }

    const data = await res.json();

    return NextResponse.json({
      available_models: data.available_models ?? [],
      default_model: data.default_model ?? '',
    });
  } catch {
    return NextResponse.json(
      { error: 'Ask-AI service unreachable' },
      { status: 502 }
    );
  }
}
