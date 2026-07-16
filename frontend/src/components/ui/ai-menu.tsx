'use client';

import * as React from 'react';

import {
  AIChatPlugin,
  AIPlugin,
  acceptAISuggestions,
  rejectAISuggestions,
  useEditorChat,
  useLastAssistantMessage,
} from '@platejs/ai/react';
import { getTransientCommentKey } from '@platejs/comment';
import { BlockSelectionPlugin, useIsSelecting } from '@platejs/selection/react';
import { getTransientSuggestionKey } from '@platejs/suggestion';
import { Command as CommandPrimitive } from 'cmdk';
import {
  Album,
  BadgeHelp,
  BookOpenCheck,
  Check,
  CornerUpLeft,
  FeatherIcon,
  ListEnd,
  ListMinus,
  ListPlus,
  Loader2Icon,
  PauseIcon,
  PenLine,
  SmileIcon,
  Wand,
  X,
} from 'lucide-react';
import {
  type NodeEntry,
  type SlateEditor,
  isHotkey,
  KEYS,
  NodeApi,
  TextApi,
} from 'platejs';
import {
  useEditorPlugin,
  useFocusedLast,
  useHotkeys,
  usePluginOption,
} from 'platejs/react';
import { type PlateEditor, useEditorRef } from 'platejs/react';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  currentAuthor,
  markEditorTextAsAi,
  stampPendingAiEdits,
} from '@/lib/ai-attribution';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { commentPlugin } from '@/components/editor/plugins/comment-kit';
import { getFreshToken } from '@/lib/api/client';

import { AIChatEditor } from './ai-chat-editor';

export function AIMenu() {
  const { api, editor } = useEditorPlugin(AIChatPlugin);
  const mode = usePluginOption(AIChatPlugin, 'mode');
  const toolName = usePluginOption(AIChatPlugin, 'toolName');

  const streaming = usePluginOption(AIChatPlugin, 'streaming');
  const isSelecting = useIsSelecting();
  const isFocusedLast = useFocusedLast();
  const open = usePluginOption(AIChatPlugin, 'open') && isFocusedLast;
  const [value, setValue] = React.useState('');

  const [input, setInput] = React.useState('');

  const chat = usePluginOption(AIChatPlugin, 'chat');

  const { messages, status } = chat;
  const [anchorElement, setAnchorElement] = React.useState<HTMLElement | null>(
    null
  );

  const content = useLastAssistantMessage()?.parts.find(
    (part) => part.type === 'text'
  )?.text;

  React.useEffect(() => {
    if (!streaming) return;

    const anchorEntry = api.aiChat.node({ anchor: true });
    if (!anchorEntry) return;

    const anchorDom = editor.api.toDOMNode(anchorEntry[0])!;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Position the popover from editor DOM while the edit stream is active.
    setAnchorElement(anchorDom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  const setOpen = (open: boolean) => {
    if (open) {
      api.aiChat.show();
    } else {
      api.aiChat.hide();
    }
  };

  const show = (anchorElement: HTMLElement) => {
    setAnchorElement(anchorElement);
    setOpen(true);
  };

  useEditorChat({
    onOpenBlockSelection: (blocks: NodeEntry[]) => {
      show(editor.api.toDOMNode(blocks.at(-1)![0])!);
    },
    onOpenChange: (open) => {
      if (!open) {
        setAnchorElement(null);
        setInput('');
      }
    },
    onOpenCursor: () => {
      const [ancestor] = editor.api.block({ highest: true })!;

      if (!editor.api.isAt({ end: true }) && !editor.api.isEmpty(ancestor)) {
        editor
          .getApi(BlockSelectionPlugin)
          .blockSelection.set(ancestor.id as string);
      }

      show(editor.api.toDOMNode(ancestor)!);
    },
    onOpenSelection: () => {
      show(editor.api.toDOMNode(editor.api.blocks().at(-1)![0])!);
    },
  });

  useHotkeys('esc', () => {
    api.aiChat.stop();
  });

  const isLoading = status === 'streaming' || status === 'submitted';

  React.useEffect(() => {
    if (toolName !== 'edit' || mode !== 'chat' || isLoading) return;

    let anchorNode = editor.api.node({
      at: [],
      reverse: true,
      match: (n) => !!n[KEYS.suggestion] && !!n[getTransientSuggestionKey()],
    });

    if (!anchorNode) {
      anchorNode = editor
        .getApi(BlockSelectionPlugin)
        .blockSelection.getNodes({ selectionFallback: true, sort: true })
        .at(-1);
    }

    if (!anchorNode) return;

    const block = editor.api.block({ at: anchorNode[1] });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Position the popover from editor DOM after the edit stream completes.
    setAnchorElement(editor.api.toDOMNode(block![0]!)!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  if (isLoading && mode === 'insert') return null;

  if (toolName === 'comment') return null;

  if (toolName === 'edit' && mode === 'chat' && isLoading) return null;

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverAnchor virtualRef={{ current: anchorElement! }} />

      <PopoverContent
        className="border-none bg-transparent p-0 shadow-none"
        style={{
          width: anchorElement?.offsetWidth,
        }}
        onEscapeKeyDown={(e) => {
          e.preventDefault();

          api.aiChat.hide();
        }}
        align="center"
        side="bottom"
      >
        <Command
          className="w-full rounded-lg border shadow-md"
          value={value}
          onValueChange={setValue}
        >
          {mode === 'chat' &&
            isSelecting &&
            content &&
            toolName === 'generate' && <AIChatEditor content={content} />}

          {isLoading ? (
            <div className="flex grow select-none items-center gap-2 p-2 text-muted-foreground text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              {messages.length > 1 ? 'Editing...' : 'Thinking...'}
            </div>
          ) : (
            <CommandPrimitive.Input
              className={cn(
                'flex h-9 w-full min-w-0 border-input bg-transparent px-3 py-1 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground md:text-sm dark:bg-input/30',
                'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
                'border-b focus-visible:ring-transparent'
              )}
              value={input}
              onKeyDown={(e) => {
                if (isHotkey('backspace')(e) && input.length === 0) {
                  e.preventDefault();
                  api.aiChat.hide();
                }
                if (isHotkey('enter')(e) && !e.shiftKey && !value) {
                  e.preventDefault();
                  void api.aiChat.submit(input);
                  setInput('');
                }
              }}
              onValueChange={setInput}
              placeholder="Ask AI anything..."
              data-plate-focus
              autoFocus
            />
          )}

          {!isLoading && (
            <CommandList>
              <AIMenuItems
                input={input}
                setInput={setInput}
                setValue={setValue}
              />
            </CommandList>
          )}

          {!isLoading && <AIModelLabel />}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The signed-in user's assigned model, cached for the page's lifetime. */
let cachedAssignedModel: string | null = null;

/**
 * Shows which AI model this user's editor is using, at the bottom of the Ask-AI
 * popup. Read-only: the model is assigned per user by an admin (Admin > Users >
 * AI Model) and resolved server-side, so there is nothing to pick here.
 */
function AIModelLabel() {
  const [label, setLabel] = React.useState<string | null>(cachedAssignedModel);

  React.useEffect(() => {
    if (cachedAssignedModel) return;

    let cancelled = false;

    void (async () => {
      try {
        const token = await getFreshToken();

        if (!token) return;

        const res = await fetch('/api/ai/models', {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) return;

        const data = await res.json();
        cachedAssignedModel = data.display_name || data.assigned_model || null;

        if (!cancelled && cachedAssignedModel) setLabel(cachedAssignedModel);
      } catch {
        // Unresolvable — the label simply doesn't render; the request itself
        // still works (the backend resolves the model regardless).
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!label) return null;

  return (
    <div className="flex items-center gap-2 border-t px-3 py-1.5 text-muted-foreground text-xs">
      <span className="shrink-0">Model</span>
      <span className="truncate" title={`${label} — assigned by your administrator`}>
        {label}
      </span>
    </div>
  );
}

type EditorChatState =
  | 'cursorCommand'
  | 'cursorSuggestion'
  | 'selectionCommand'
  | 'selectionSuggestion';

const AICommentIcon = () => (
  <svg
    fill="none"
    height="24"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M0 0h24v24H0z" fill="none" stroke="none" />
    <path d="M8 9h8" />
    <path d="M8 13h4.5" />
    <path d="M10 19l-1 -1h-3a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v4.5" />
    <path d="M17.8 20.817l-2.172 1.138a.392 .392 0 0 1 -.568 -.41l.415 -2.411l-1.757 -1.707a.389 .389 0 0 1 .217 -.665l2.428 -.352l1.086 -2.193a.392 .392 0 0 1 .702 0l1.086 2.193l2.428 .352a.39 .39 0 0 1 .217 .665l-1.757 1.707l.414 2.41a.39 .39 0 0 1 -.567 .411l-2.172 -1.138z" />
  </svg>
);

const aiChatItems = {
  accept: {
    icon: <Check />,
    label: 'Accept',
    value: 'accept',
    onSelect: ({ aiEditor, editor }) => {
      const { mode, toolName } = editor.getOptions(AIChatPlugin);

      if (mode === 'chat' && toolName === 'generate') {
        // Attribute the generated text (lives in the AI sub-editor) before it
        // is inserted into the document.
        markEditorTextAsAi(aiEditor, currentAuthor(editor));
        return editor
          .getTransforms(AIChatPlugin)
          .aiChat.replaceSelection(aiEditor);
      }

      // Edit mode applies changes as suggestion marks (green insert / red delete).
      // Finalize them: insertions become permanent text (un-highlighted),
      // deletions are removed from the document.
      if (mode === 'chat' && toolName === 'edit') {
        // Tag the AI insertions with attribution before they're finalized.
        stampPendingAiEdits(editor);
        acceptAISuggestions(editor);
        editor.getApi(AIChatPlugin).aiChat.hide();
        editor.tf.focus({ edge: 'end' });
        return;
      }

      // Insert mode: the streamed preview text carries the transient AI mark;
      // attribute it before accept turns it into permanent text.
      stampPendingAiEdits(editor);
      editor.getTransforms(AIChatPlugin).aiChat.accept();
      editor.tf.focus({ edge: 'end' });
    },
  },
  comment: {
    icon: <AICommentIcon />,
    label: 'Comment',
    value: 'comment',
    onSelect: ({ editor, input }) => {
      editor.getApi(AIChatPlugin).aiChat.submit(input, {
        mode: 'insert',
        prompt:
          'Analyze the selected text or document. Provide constructive, specific, and actionable feedback or comments directly addressing the content\'s clarity, structure, tone, or styling. Your response should be a concise, helpful editorial comment. Do not include conversational filler like "Sure, here is your comment" or "I think...".',
        toolName: 'comment',
      });
    },
  },
  continueWrite: {
    icon: <PenLine />,
    label: 'Continue writing',
    value: 'continueWrite',
    onSelect: ({ editor, input }) => {
      const ancestorNode = editor.api.block({ highest: true });

      if (!ancestorNode) return;

      const isEmpty = NodeApi.string(ancestorNode[0]).trim().length === 0;

      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        mode: 'insert',
        prompt: isEmpty
          ? `You are an expert co-writer. Read the current document state:
<Document>
{editor}
</Document>
Write exactly one new, highly contextually relevant sentence to begin a new paragraph immediately following the document above. Do not repeat existing text. Output ONLY the raw text of that single sentence—no formatting, no conversational preamble, and no markdown block wrappers.`
          : `You are an expert co-writer. Read the context block:
<Block>
{editor}
</Block>
Continue writing seamlessly immediately after this block. Write exactly one highly engaging, contextually coherent sentence. Do not repeat any existing text. Output ONLY the raw text of that single sentence—no formatting, no conversational preamble, and no markdown block wrappers.`,
        toolName: 'generate',
      });
    },
  },
  discard: {
    icon: <X />,
    label: 'Discard',
    shortcut: 'Escape',
    value: 'discard',
    onSelect: ({ editor }) => {
      const { mode, toolName } = editor.getOptions(AIChatPlugin);
      // Edit mode: drop the suggestion marks (remove green inserts, restore red deletes).
      if (mode === 'chat' && toolName === 'edit') {
        rejectAISuggestions(editor);
      } else {
        editor.getTransforms(AIPlugin).ai.undo();
      }
      editor.getApi(AIChatPlugin).aiChat.hide();
    },
  },
  emojify: {
    icon: <SmileIcon />,
    label: 'Emojify',
    value: 'emojify',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt:
          'You are an inline text enhancer. Tastefully insert contextually relevant emojis within the provided text blocks to add visual engagement.\n\nCRITICAL RULES:\n1. Do NOT alter, rewrite, or delete any of the existing words, sentences, or punctuation.\n2. Do NOT touch or modify Markdown syntax, links, HTML, formatting marks, or line breaks.\n3. Output ONLY the augmented text containing the added emojis. Absolutely no prefaces, conversational filler, or explanations.',
        toolName: 'edit',
      });
    },
  },
  explain: {
    icon: <BadgeHelp />,
    label: 'Explain',
    value: 'explain',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt: {
          default: 'Provide a clear, detailed, and insightful explanation of the following document content:\n\n{editor}\n\nBreak down complex concepts or terminology into accessible language. Keep the tone professional and educational, and avoid conversational filler or meta-introductions.',
          selecting: 'Provide a clear, detailed, and insightful explanation of the selected text. Break down complex concepts or terminology into accessible language. Keep the tone professional and educational, and avoid conversational filler or meta-introductions.',
        },
        toolName: 'generate',
      });
    },
  },
  fixSpelling: {
    icon: <Check />,
    label: 'Fix spelling & grammar',
    value: 'fixSpelling',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt:
          'You are a professional proofreader. Correct any spelling, typographical, grammatical, syntax, and punctuation errors within the text blocks.\n\nCRITICAL RULES:\n1. Preserve the author\'s original vocabulary, voice, meaning, and tone strictly.\n2. Do not rewrite sentences or add/remove substantive information.\n3. Retain all Markdown elements, links, formatting, and structures intact.\n4. Output ONLY the finalized, error-free text with no commentary, markdown code blocks, or conversational preambles.',
        toolName: 'edit',
      });
    },
  },
  generateMarkdownSample: {
    icon: <BookOpenCheck />,
    label: 'Generate Markdown sample',
    value: 'generateMarkdownSample',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt: 'Generate a rich, comprehensive, and well-structured markdown document sample. The sample should realistically showcase a balanced variety of markdown features including different levels of headings (H1, H2, H3), paragraphs, nested lists (bulleted and numbered), blockquotes, text formatting (bold, italics, strikethrough), an inline code snippet, a block code snippet, a horizontal rule, and a simple table. Make the content realistic (e.g., mock documentation or a quickstart guide). Output ONLY the raw markdown content itself. Do not wrap the entire response in extra markdown blockquotes or triple backticks.',
        toolName: 'generate',
      });
    },
  },
  generateMdxSample: {
    icon: <BookOpenCheck />,
    label: 'Generate MDX sample',
    value: 'generateMdxSample',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt: 'Generate a clean, professional, and syntactically valid MDX (Markdown with JSX) sample. Include standard Markdown elements like headings, inline text formatting, lists, and blockquotes alongside standard React JSX custom elements (e.g., an `<Alert title="Note" variant="info">` component, a custom interactive `<Badge>`, or a `<CodeSnippet>` block) imported or rendered naturally within the text. Output ONLY the raw MDX file contents with no surrounding markdown blockquotes or introductory/concluding explanations.',
        toolName: 'generate',
      });
    },
  },
  improveWriting: {
    icon: <Wand />,
    label: 'Improve writing',
    value: 'improveWriting',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt:
          'You are an expert editorial writer. Enhance the clarity, flow, readability, and overall professional quality of the text blocks.\n\nCRITICAL RULES:\n1. Maintain the author\'s original message, core meaning, and perspective completely.\n2. Do not introduce new ideas or delete crucial arguments.\n3. Keep the tone appropriate to the context (polished and fluent).\n4. Preserve all Markdown syntax, links, and structure.\n5. Output ONLY the improved text directly without any introductory conversational statements, explanations, or wrapping blockcodes.',
        toolName: 'edit',
      });
    },
  },
  insertBelow: {
    icon: <ListEnd />,
    label: 'Insert below',
    value: 'insertBelow',
    onSelect: ({ aiEditor, editor }) => {
      markEditorTextAsAi(aiEditor, currentAuthor(editor));
      /** Format: 'none' Fix insert table */
      void editor
        .getTransforms(AIChatPlugin)
        .aiChat.insertBelow(aiEditor, { format: 'none' });
    },
  },
  makeLonger: {
    icon: <ListPlus />,
    label: 'Make longer',
    value: 'makeLonger',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt:
          'You are a detailed content writer. Elaborate on the ideas, points, or arguments in the text blocks to make them more descriptive, detailed, and comprehensive.\n\nCRITICAL RULES:\n1. Expand only by detailing the existing concepts—do not wander into unrelated topics or change the underlying meaning.\n2. Keep the writing natural, engaging, and professional. Avoid inserting fluff or redundant phrases.\n3. Output ONLY the expanded text blocks directly. Do not include introductory notes, explanations, or surrounding formatting wrappers.',
        toolName: 'edit',
      });
    },
  },
  makeShorter: {
    icon: <ListMinus />,
    label: 'Make shorter',
    value: 'makeShorter',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt:
          'You are an expert content editor. Condense the text blocks to make them highly concise and punchy, removing redundant words or passive phrasing.\n\nCRITICAL RULES:\n1. Maintain all key information, core arguments, and original meaning intact.\n2. Do not omit crucial details or modify the author\'s perspective.\n3. Simplify sentence structures for fast reading.\n4. Output ONLY the shortened, concise text block directly without conversational preambles or explanations.',
        toolName: 'edit',
      });
    },
  },
  replace: {
    icon: <Check />,
    label: 'Replace selection',
    value: 'replace',
    onSelect: ({ aiEditor, editor }) => {
      markEditorTextAsAi(aiEditor, currentAuthor(editor));
      void editor.getTransforms(AIChatPlugin).aiChat.replaceSelection(aiEditor);
    },
  },
  simplifyLanguage: {
    icon: <FeatherIcon />,
    label: 'Simplify language',
    value: 'simplifyLanguage',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        prompt:
          'You are a plain-language writer. Simplify the phrasing and vocabulary of the text blocks to make them highly clear, accessible, and direct.\n\nCRITICAL RULES:\n1. Replace high-level jargon, convoluted syntax, and wordiness with clear, everyday phrasing.\n2. Do not change the original facts, meaning, or add new details.\n3. Retain any Markdown links or formatting patterns.\n4. Output ONLY the simplified version of the text directly with no commentary or prefaces.',
        toolName: 'edit',
      });
    },
  },
  summarize: {
    icon: <Album />,
    label: 'Add a summary',
    value: 'summarize',
    onSelect: ({ editor, input }) => {
      void editor.getApi(AIChatPlugin).aiChat.submit(input, {
        mode: 'insert',
        prompt: {
          default: 'Read the following document carefully:\n\n{editor}\n\nProduce a highly concise, objective, and clear summary of the core points, key insights, and main conclusions. Output ONLY the summary text, with no preamble, "Here is a summary", or closing conversational filler.',
          selecting: 'Produce a highly concise, objective, and clear summary of the selected text, highlighting the core points and main takeaways. Output ONLY the summary text directly, with no preamble or conversational filler.',
        },
        toolName: 'generate',
      });
    },
  },
  tryAgain: {
    icon: <CornerUpLeft />,
    label: 'Try again',
    value: 'tryAgain',
    onSelect: ({ editor }) => {
      void editor.getApi(AIChatPlugin).aiChat.reload();
    },
  },
} satisfies Record<
  string,
  {
    icon: React.ReactNode;
    label: string;
    value: string;
    component?: React.ComponentType<{ menuState: EditorChatState }>;
    filterItems?: boolean;
    items?: { label: string; value: string }[];
    shortcut?: string;
    onSelect?: ({
      aiEditor,
      editor,
      input,
    }: {
      aiEditor: SlateEditor;
      editor: PlateEditor;
      input: string;
    }) => void;
  }
>;

const menuStateItems: Record<
  EditorChatState,
  {
    items: (typeof aiChatItems)[keyof typeof aiChatItems][];
    heading?: string;
  }[]
> = {
  cursorCommand: [
    {
      items: [
        aiChatItems.comment,
        aiChatItems.generateMdxSample,
        aiChatItems.generateMarkdownSample,
        aiChatItems.continueWrite,
        aiChatItems.summarize,
        aiChatItems.explain,
      ],
    },
  ],
  cursorSuggestion: [
    {
      items: [aiChatItems.accept, aiChatItems.discard, aiChatItems.tryAgain],
    },
  ],
  selectionCommand: [
    {
      items: [
        aiChatItems.improveWriting,
        aiChatItems.comment,
        aiChatItems.emojify,
        aiChatItems.makeLonger,
        aiChatItems.makeShorter,
        aiChatItems.fixSpelling,
        aiChatItems.simplifyLanguage,
      ],
    },
  ],
  selectionSuggestion: [
    {
      items: [
        aiChatItems.accept,
        aiChatItems.discard,
        aiChatItems.insertBelow,
        aiChatItems.tryAgain,
      ],
    },
  ],
};

export const AIMenuItems = ({
  input,
  setInput,
  setValue,
}: {
  input: string;
  setInput: (value: string) => void;
  setValue: (value: string) => void;
}) => {
  const editor = useEditorRef();
  const { messages } = usePluginOption(AIChatPlugin, 'chat');
  const aiEditor = usePluginOption(AIChatPlugin, 'aiEditor')!;
  const isSelecting = useIsSelecting();

  const menuState = React.useMemo(() => {
    if (messages && messages.length > 0) {
      return isSelecting ? 'selectionSuggestion' : 'cursorSuggestion';
    }

    return isSelecting ? 'selectionCommand' : 'cursorCommand';
  }, [isSelecting, messages]);

  const menuGroups = React.useMemo(() => {
    const items = menuStateItems[menuState];

    return items;
  }, [menuState]);

  React.useEffect(() => {
    if (menuGroups.length > 0 && menuGroups[0].items.length > 0) {
      setValue(menuGroups[0].items[0].value);
    }
  }, [menuGroups, setValue]);

  return (
    <>
      {menuGroups.map((group, index) => (
        <CommandGroup key={index} heading={group.heading}>
          {group.items.map((menuItem) => (
            <CommandItem
              key={menuItem.value}
              className="[&_svg]:text-muted-foreground"
              value={menuItem.value}
              onSelect={() => {
                menuItem.onSelect?.({
                  aiEditor,
                  editor,
                  input,
                });
                setInput('');
              }}
            >
              {menuItem.icon}
              <span>{menuItem.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  );
};

export function AILoadingBar() {
  const editor = useEditorRef();

  const toolName = usePluginOption(AIChatPlugin, 'toolName');
  const chat = usePluginOption(AIChatPlugin, 'chat');
  const mode = usePluginOption(AIChatPlugin, 'mode');

  const { status } = chat;

  const { api } = useEditorPlugin(AIChatPlugin);

  const isLoading = status === 'streaming' || status === 'submitted';

  const handleComments = (type: 'accept' | 'reject') => {
    if (type === 'accept') {
      editor.tf.unsetNodes([getTransientCommentKey()], {
        at: [],
        match: (n) => TextApi.isText(n) && !!n[KEYS.comment],
      });
    }

    if (type === 'reject') {
      editor
        .getTransforms(commentPlugin)
        .comment.unsetMark({ transient: true });
    }

    api.aiChat.hide();
  };

  useHotkeys('esc', () => {
    api.aiChat.stop();
  });

  if (
    isLoading &&
    (mode === 'insert' ||
      toolName === 'comment' ||
      (toolName === 'edit' && mode === 'chat'))
  ) {
    return (
      <div
        className={cn(
          '-translate-x-1/2 absolute bottom-4 left-1/2 z-20 flex items-center gap-3 rounded-md border border-border bg-muted px-3 py-1.5 text-muted-foreground text-sm shadow-md transition-all duration-300'
        )}
      >
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        <span>{status === 'submitted' ? 'Thinking...' : 'Writing...'}</span>
        <Button
          size="sm"
          variant="ghost"
          className="flex items-center gap-1 text-xs"
          onClick={() => api.aiChat.stop()}
        >
          <PauseIcon className="h-4 w-4" />
          Stop
          <kbd className="ml-1 rounded bg-border px-1 font-mono text-[10px] text-muted-foreground shadow-sm">
            Esc
          </kbd>
        </Button>
      </div>
    );
  }

  if (toolName === 'comment' && status === 'ready') {
    return (
      <div
        className={cn(
          '-translate-x-1/2 absolute bottom-4 left-1/2 z-50 flex flex-col items-center gap-0 rounded-xl border border-border/50 bg-popover p-1 text-muted-foreground text-sm shadow-xl backdrop-blur-sm',
          'p-3'
        )}
      >
        {/* Header with controls */}
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex items-center gap-5">
            <Button
              size="sm"
              disabled={isLoading}
              onClick={() => handleComments('accept')}
            >
              Accept
            </Button>

            <Button
              size="sm"
              disabled={isLoading}
              onClick={() => handleComments('reject')}
            >
              Reject
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}