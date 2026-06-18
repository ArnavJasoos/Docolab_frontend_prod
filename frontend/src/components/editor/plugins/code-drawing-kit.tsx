'use client';

import dynamic from 'next/dynamic';

import { CodeDrawingPlugin } from '@platejs/code-drawing/react';

// The drawing canvas is heavy and only needed when a document actually contains
// a code-drawing node. Keep the plugin registered (so the node type, parsing
// and shortcuts work) but defer the canvas UI until it renders.
const CodeDrawingElement = dynamic(
  () =>
    import('@/components/ui/code-drawing-node').then(
      (m) => m.CodeDrawingElement,
    ),
  { ssr: false },
);

export const CodeDrawingKit = [
  CodeDrawingPlugin.withComponent(CodeDrawingElement),
];
