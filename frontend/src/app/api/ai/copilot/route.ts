import type { NextRequest } from 'next/server';

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const {
    apiKey: key,
    model = 'gemini-2.5-flash',
    prompt,
    system,
  } = await req.json();

  const apiKey = key || process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Missing Gemini API key. Set GOOGLE_GENERATIVE_AI_API_KEY.' },
      { status: 401 }
    );
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const modelId = model.startsWith('gemini') ? model : 'gemini-2.5-flash';

  try {
    const result = await generateText({
      abortSignal: req.signal,
      maxOutputTokens: 50,
      model: google(modelId),
      prompt,
      system,
      temperature: 0.7,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(null, { status: 408 });
    }

    return NextResponse.json(
      { error: 'Failed to process AI request' },
      { status: 500 }
    );
  }
}
