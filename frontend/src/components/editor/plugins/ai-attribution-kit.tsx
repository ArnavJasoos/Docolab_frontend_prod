'use client';

import * as React from 'react';
import { createPlatePlugin, usePluginOption } from 'platejs/react';
import type { PlateLeafProps } from 'platejs/react';
import { PlateLeaf } from 'platejs/react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { AI_EDIT_KEY, type AiEditMark } from '@/lib/ai-attribution';

/**
 * Renders AI-authored text. When the "Show AI Edits" toggle (the `show` option)
 * is on, leaves carrying the `aiEdit` mark are highlighted blue and reveal a
 * popover naming who used the AI. When off, the text renders normally.
 */
function AiEditLeaf(props: PlateLeafProps) {
  const show = usePluginOption(aiAttributionPlugin, 'show') as boolean;
  const leaf = props.leaf as Record<string, unknown>;
  const mark = leaf[AI_EDIT_KEY] as AiEditMark | undefined;

  // In the compare view an AI leaf may also carry a diff op; there the diff
  // plugin owns all colouring (blue included), so defer to it. Live-editor
  // leaves never have `diff`, so this is a no-op outside compare.
  if (leaf.diff) {
    return <PlateLeaf {...props}>{props.children}</PlateLeaf>;
  }

  if (!show || !mark) {
    return <PlateLeaf {...props}>{props.children}</PlateLeaf>;
  }

  return (
    <PlateLeaf {...props}>
      <Popover>
        <PopoverTrigger asChild>
          <span
            className="cursor-help rounded-sm bg-primary-container/20 text-text-primary underline decoration-primary-container/50 decoration-dotted underline-offset-2"
            data-ai-edit="true"
          >
            {props.children}
          </span>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto border border-border-subtle bg-document-surface px-3 py-2 shadow-float"
          align="start"
          side="top"
        >
          <p className="font-ui-xs text-ui-xs text-text-secondary">
            <span className="inline-flex items-center gap-1 font-semibold text-primary-container">
              <span className="material-symbols-outlined text-[14px]">
                auto_awesome
              </span>
              AI edit
            </span>{' '}
            by{' '}
            <span className="font-semibold text-text-primary">
              {mark.authorName}
            </span>
          </p>
        </PopoverContent>
      </Popover>
    </PlateLeaf>
  );
}

/**
 * Marks text authored by AI. `node.isLeaf` makes Plate route any text leaf
 * carrying the `aiEdit` prop through `AiEditLeaf`. The `show` option is toggled
 * from the View menu ("Show AI Edits").
 */
export const aiAttributionPlugin = createPlatePlugin({
  key: AI_EDIT_KEY,
  node: { isLeaf: true },
  options: { show: false },
}).withComponent(AiEditLeaf);

export const AiAttributionKit = [aiAttributionPlugin];
