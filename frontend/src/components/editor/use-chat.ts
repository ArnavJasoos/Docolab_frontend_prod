'use client';

import * as React from 'react';

import { type UseChatHelpers, useChat as useBaseChat } from '@ai-sdk/react';
import { withAIBatch } from '@platejs/ai';
import {
  AIChatPlugin,
  aiCommentToRange,
  applyTableCellSuggestion,
} from '@platejs/ai/react';
import { getCommentKey, getTransientCommentKey } from '@platejs/comment';
import { deserializeMd } from '@platejs/markdown';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { type UIMessage, DefaultChatTransport } from 'ai';
import { type TNode, KEYS, nanoid, NodeApi, TextApi } from 'platejs';
import { type PlateEditor, useEditorRef, usePluginOption } from 'platejs/react';
import { toast } from 'sonner';

import { aiChatPlugin } from '@/components/editor/plugins/ai-kit';
import { getCurrentUser } from '@/lib/api/auth';

import { discussionPlugin } from './plugins/discussion-kit';

export type ToolName = 'comment' | 'edit' | 'generate';

export type TComment = {
  comment: {
    blockId: string;
    comment: string;
    content: string;
  } | null;
  status: 'finished' | 'streaming';
};

export type TTableCellUpdate = {
  cellUpdate: {
    content: string;
    id: string;
  } | null;
  status: 'finished' | 'streaming';
};

export type MessageDataPart = {
  toolName: ToolName;
  comment?: TComment;
  table?: TTableCellUpdate;
};

export type Chat = UseChatHelpers<ChatMessage>;

export type ChatMessage = UIMessage<unknown, MessageDataPart>;

/** localStorage key holding the user's Ask-AI model pick ('provider:model_key'). */
export const AI_MODEL_STORAGE_KEY = 'docolab.ai-model';

function createChatTransport({
  api,
  editor,
}: {
  api: string;
  editor: PlateEditor;
}) {
  return new DefaultChatTransport({
    api,
    fetch: (async (input, init) => {
      const bodyOptions = editor.getOptions(aiChatPlugin).chatOptions?.body;

      const initBody = JSON.parse(init?.body as string);

      // Ask-AI service contract: the session is unique per user (multi-turn
      // memory), and the model is whatever the user picked in the AI menu
      // (empty → the service's default model).
      const sessionId = getCurrentUser()?.id ?? 'anonymous';
      const model =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(AI_MODEL_STORAGE_KEY) || undefined
          : undefined;

      const body = {
        ...initBody,
        ...bodyOptions,
        model,
        sessionId,
      };

      const res = await fetch(input, {
        ...init,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let message = 'AI request failed.';

        try {
          const data = await res.json();

          if (typeof data?.error === 'string') message = data.error;
        } catch {
          // non-JSON error body — keep the generic message
        }

        throw new Error(message);
      }

      return res;
    }) as typeof fetch,
  });
}

export const useChat = () => {
  const editor = useEditorRef();
  const options = usePluginOption(aiChatPlugin, 'chatOptions');

  const transport = React.useMemo(
    () =>
      createChatTransport({
        api: options.api || '/api/ai/command',
        editor,
      }),
    [editor, options.api]
  );

  const chat = useBaseChat<ChatMessage>({
    id: 'editor',
    transport,
    onError(error) {
      toast.error(error.message || 'AI request failed.');
    },
    onData(data) {
      if (data.type === 'data-toolName') {
        editor.setOption(AIChatPlugin, 'toolName', data.data as ToolName);
      }

      if (data.type === 'data-table' && data.data) {
        const tableData = data.data as TTableCellUpdate;

        if (tableData.status === 'finished') {
          const chatSelection = editor.getOption(AIChatPlugin, 'chatSelection');

          if (!chatSelection) return;

          editor.tf.setSelection(chatSelection);

          return;
        }

        const cellUpdate = tableData.cellUpdate!;

        withAIBatch(editor, () => {
          applyTableCellSuggestion(editor, cellUpdate);
        });
      }

      if (data.type === 'data-comment' && data.data) {
        const commentData = data.data as TComment;

        if (commentData.status === 'finished') {
          editor.getApi(BlockSelectionPlugin).blockSelection.deselect();

          return;
        }

        const aiComment = commentData.comment!;
        const range = aiCommentToRange(editor, aiComment);

        if (!range) return console.warn('No range found for AI comment');

        const discussions =
          editor.getOption(discussionPlugin, 'discussions') || [];

        // Generate a new discussion ID
        const discussionId = nanoid();

        // Create a new comment
        const newComment = {
          id: nanoid(),
          contentRich: [{ children: [{ text: aiComment.comment }], type: 'p' }],
          createdAt: new Date(),
          discussionId,
          isEdited: false,
          userId: editor.getOption(discussionPlugin, 'currentUserId'),
        };

        // Create a new discussion
        const newDiscussion = {
          id: discussionId,
          comments: [newComment],
          createdAt: new Date(),
          documentContent: deserializeMd(editor, aiComment.content)
            .map((node: TNode) => NodeApi.string(node))
            .join('\n'),
          isResolved: false,
          userId: editor.getOption(discussionPlugin, 'currentUserId'),
        };

        // Update discussions
        const updatedDiscussions = [...discussions, newDiscussion];
        editor.setOption(discussionPlugin, 'discussions', updatedDiscussions);

        // Apply comment marks to the editor
        editor.tf.withMerging(() => {
          editor.tf.setNodes(
            {
              [getCommentKey(newDiscussion.id)]: true,
              [getTransientCommentKey()]: true,
              [KEYS.comment]: true,
            },
            {
              at: range,
              match: TextApi.isText,
              split: true,
            }
          );
        });
      }
    },

    ...options,
  });

  React.useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the plugin's Chat option type predates AI SDK v6 helpers
    editor.setOption(AIChatPlugin, 'chat', chat as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.status, chat.messages, chat.error]);

  return chat;
};
