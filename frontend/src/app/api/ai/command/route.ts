// =============================================================================
// app/api/ai/command/route.ts
//
// Ask-AI command route. The Plate editor (AIChatPlugin / use-chat) posts here;
// this route translates the editor request into the standalone Ask-AI
// service's `POST /ask` contract and converts the JSON answer back into the
// UI-message stream the editor already consumes — so the existing streaming
// insert, suggestion diffing, and Accept / Reject flows keep working
// unchanged on top of the new backend.
//
//   POST {ASK_AI_URL}/ask
//   { "query": ..., "context": ..., "model": ..., "session_id": ... }
//
// - query      → what the user typed, or the instruction behind the Ask-AI
//                action the user clicked (fix grammar, make longer, ...).
// - context    → the section of the document the user selected.
// - model      → the user's model pick ('provider:model_key'); empty = the
//                service's default_model.
// - session_id → unique per user (multi-turn memory lives in the service).
//
// Vendor keys live ONLY in ask-ai-service/.env — nothing AI-secret is here.
// =============================================================================

import type { NextRequest } from 'next/server';

import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { NextResponse } from 'next/server';
import { createSlateEditor, nanoid } from 'platejs';

import type { ChatMessage, ToolName } from '@/components/editor/use-chat';

import { BaseEditorKit } from '@/components/editor/editor-base-kit';

import {
  buildEditTableMultiCellPrompt,
  getCommentPrompt,
  getEditPrompt,
  getGeneratePrompt,
} from './prompt';
import {
  addSelection,
  getLastUserInstruction,
  getMarkdownWithSelection,
  isMultiBlocks,
} from './utils';

// LLM calls routinely exceed serverless defaults; give the hosted (Vercel)
// function up to 60s before the platform kills the request. No effect in dev.
export const maxDuration = 60;

const ASK_AI_URL = (process.env.ASK_AI_URL || 'http://localhost:8001').replace(
  /\/+$/,
  ''
);
// Optional shared secret matching the service's ASK_AI_SERVICE_TOKEN. When
// both sides set it, /ask calls carry it as a Bearer token; when unset the
// request is sent exactly as before.
const ASK_AI_SERVICE_TOKEN = process.env.ASK_AI_SERVICE_TOKEN;

/** Directive appended to prompts whose answer must be machine-parseable. */
const JSON_ONLY_RULE =
  'CRITICAL: Respond with ONLY the raw JSON array. No prose, no explanations, no markdown code fences.';

interface AskResponse {
  context_compressed: boolean;
  input_tokens: number;
  model: string;
  response: string;
  session_id?: string | null;
}

class AskAIError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** Turn the service's error `detail` payload into a user-readable message. */
function detailToMessage(status: number, detail: unknown): string {
  if (typeof detail === 'string') return detail;

  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>;

    if (status === 429) {
      const retry = Math.ceil(Number(d.retry_after_seconds ?? 0));
      return `AI rate limit reached (${d.scope ?? 'quota'}) for ${d.model ?? 'this model'}. Try again in ~${retry || 60}s or switch model.`;
    }
    if (status === 422 && d.error === 'context_window_exceeded') {
      return `Selection is too large for ${d.model ?? 'the model'} (${d.input_tokens} tokens, limit ${d.limit_tokens}). Select a smaller section or switch model.`;
    }
    if (typeof d.message === 'string') return d.message;
  }

  return 'AI request failed.';
}

async function askAI(
  payload: {
    context: string;
    model?: string;
    query: string;
    session_id?: string;
  },
  signal: AbortSignal
): Promise<AskResponse> {
  let res: Response;

  try {
    res = await fetch(`${ASK_AI_URL}/ask`, {
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
        ...(ASK_AI_SERVICE_TOKEN
          ? { Authorization: `Bearer ${ASK_AI_SERVICE_TOKEN}` }
          : {}),
      },
      method: 'POST',
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;

    throw new AskAIError(
      502,
      `Ask-AI service is unreachable at ${ASK_AI_URL}. Is ask-ai-service running?`
    );
  }

  if (!res.ok) {
    let detail: unknown = null;

    try {
      detail = (await res.json())?.detail;
    } catch {
      // non-JSON error body — fall through to the generic message
    }

    throw new AskAIError(res.status, detailToMessage(res.status, detail));
  }

  return (await res.json()) as AskResponse;
}

/** Extract the first JSON array found in a (possibly fenced) LLM response. */
function parseJsonArray(text: string): Record<string, unknown>[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');

  if (start === -1 || end <= start) return null;

  try {
    const value = JSON.parse(text.slice(start, end + 1));

    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Slice the answer into small deltas so the editor renders progressively. */
function* chunkText(text: string, size = 48): Generator<string> {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
  }
}

export async function POST(req: NextRequest) {
  const { ctx, messages: messagesRaw, model, sessionId } = await req.json();

  const {
    children,
    selection,
    toolName: toolNameParam,
  } = ctx ?? ({} as never);
  const messages: ChatMessage[] = messagesRaw ?? [];

  const editor = createSlateEditor({
    plugins: BaseEditorKit,
    selection,
    value: children,
  });

  const isSelecting = editor.api.isExpanded();
  const instruction = getLastUserInstruction(messages);

  // Presets pass their tool explicitly; free-typed input defaults to
  // 'generate' (edit requires a selection, so guard against a stale value).
  let toolName: ToolName = (toolNameParam as ToolName) || 'generate';

  if (toolName === 'edit' && !isSelecting) toolName = 'generate';

  // Map the editor request onto the Ask-AI contract.
  let query = '';
  let context = '';
  // How the service answer is relayed to the editor: plain text (insert /
  // suggestion diff) or structured data events (comments, table cells).
  let responseMode: 'comment' | 'table' | 'text' = 'text';
  // Multi-turn memory only helps conversational Q&A; edit/comment actions are
  // stateless transformations, and skipping the session keeps their large
  // structured prompts from crowding the model's context window over time.
  let useSession = false;

  if (toolName === 'comment') {
    responseMode = 'comment';
    query = `${getCommentPrompt(editor, { messages })}\n\n${JSON_ONLY_RULE}`;
  } else if (toolName === 'edit') {
    const [editPrompt, editType] = getEditPrompt(editor, {
      isSelecting,
      messages,
    });

    if (editType === 'table') {
      responseMode = 'table';
      query = `${buildEditTableMultiCellPrompt(editor, messages)}\n\n${JSON_ONLY_RULE}`;
    } else {
      query = editPrompt;
    }
  } else if (isSelecting) {
    // Grounded Q&A / generation over the user's selection — the selection is
    // the /ask `context`, the user's ask is the `query` (the spec's example).
    useSession = true;

    if (!isMultiBlocks(editor)) addSelection(editor);

    context = getMarkdownWithSelection(editor);
    query = context.includes('<Selection>')
      ? `${instruction}\n\n(In the context, the text between <Selection> and </Selection> is the part the user highlighted. These are input-only markers — never include them in your output.)`
      : instruction;
  } else {
    // Freeform generation at the cursor ("what is hadoop", continue writing,
    // summarize-with-{editor}-embedded, ...).
    useSession = true;
    query = getGeneratePrompt(editor, { isSelecting: false, messages });
  }

  if (!query.trim()) {
    return NextResponse.json({ error: 'Empty AI request.' }, { status: 400 });
  }

  let ask: AskResponse;

  try {
    ask = await askAI(
      {
        context,
        model: model || undefined,
        query,
        session_id: useSession && sessionId ? String(sessionId) : undefined,
      },
      req.signal
    );
  } catch (error) {
    if (error instanceof AskAIError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json(null, { status: 408 });
    }

    console.error('[ai/command] unexpected error:', error);

    return NextResponse.json(
      { error: 'Failed to process AI request' },
      { status: 500 }
    );
  }

  const stream = createUIMessageStream<ChatMessage>({
    execute: async ({ writer }) => {
      // The plugin already knows the tool for preset actions; only free-typed
      // input needs to be told which tool was chosen (mirrors the old route).
      if (!toolNameParam) {
        writer.write({ data: toolName, type: 'data-toolName' });
      }

      if (responseMode === 'comment') {
        const items = parseJsonArray(ask.response) ?? [];

        for (const item of items) {
          if (!item?.blockId || !item?.content) continue;

          writer.write({
            id: nanoid(),
            data: {
              comment: {
                blockId: String(item.blockId),
                comment: String(item.comments ?? item.comment ?? ''),
                content: String(item.content),
              },
              status: 'streaming',
            },
            type: 'data-comment',
          });
        }

        writer.write({
          id: nanoid(),
          data: { comment: null, status: 'finished' },
          type: 'data-comment',
        });

        return;
      }

      if (responseMode === 'table') {
        const items = parseJsonArray(ask.response) ?? [];

        for (const item of items) {
          if (!item?.id || item?.content === undefined) continue;

          writer.write({
            id: nanoid(),
            data: {
              cellUpdate: {
                content: String(item.content),
                id: String(item.id),
              },
              status: 'streaming',
            },
            type: 'data-table',
          });
        }

        writer.write({
          id: nanoid(),
          data: { cellUpdate: null, status: 'finished' },
          type: 'data-table',
        });

        return;
      }

      const id = nanoid();

      writer.write({ id, type: 'text-start' });

      for (const delta of chunkText(ask.response)) {
        writer.write({ delta, id, type: 'text-delta' });
      }

      writer.write({ id, type: 'text-end' });
    },
  });

  return createUIMessageStreamResponse({ stream });
}
