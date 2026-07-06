'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

import type { TExcalidrawElement } from '@platejs/excalidraw';
import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

import { cn } from '@/lib/utils';

// Defer the heavy Excalidraw runtime + CSS until a drawing actually renders.
const ExcalidrawCanvas = dynamic(
  () => import('./excalidraw-canvas').then((m) => m.ExcalidrawCanvas),
  { ssr: false }
);

export function ExcalidrawElement(
  props: PlateElementProps<TExcalidrawElement>
) {
  const { children, element } = props;

  return (
    <PlateElement {...props}>
      <div contentEditable={false}>
        <div
          className={cn(
            'mx-auto aspect-video h-[600px] w-[min(100%,600px)] overflow-hidden rounded-sm border'
          )}
        >
          <ExcalidrawCanvas element={element} />
        </div>
      </div>
      {children}
    </PlateElement>
  );
}
