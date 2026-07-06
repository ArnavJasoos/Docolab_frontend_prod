'use client';

import * as React from 'react';

import type { TExcalidrawElement } from '@platejs/excalidraw';

import { useExcalidrawElement } from '@platejs/excalidraw/react';
import { useReadOnly } from 'platejs/react';

import '@excalidraw/excalidraw/index.css';

// The actual Excalidraw canvas. Split out of excalidraw-node.tsx and loaded via
// next/dynamic so @platejs/excalidraw/react + the Excalidraw CSS/runtime only
// ship when a drawing node is present, not on every editor mount.
export function ExcalidrawCanvas({ element }: { element: TExcalidrawElement }) {
  const readOnly = useReadOnly();

  const { Excalidraw, excalidrawProps } = useExcalidrawElement({
    element,
  });

  if (!Excalidraw) return null;

  return (
    <Excalidraw
      {...(excalidrawProps as any)}
      viewModeEnabled={readOnly}
    />
  );
}
