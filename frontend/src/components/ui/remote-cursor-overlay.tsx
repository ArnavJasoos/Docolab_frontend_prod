'use client';

import * as React from 'react';

import {
  type CursorOverlayData,
  useRemoteCursorOverlayPositions,
} from '@slate-yjs/react';
import { usePluginOption } from 'platejs/react';
import { YjsPlugin } from '@platejs/yjs/react';

import type { CursorIdentity } from '@/lib/presence-identity';
import { cn } from '@/lib/utils';

/**
 * Renders every OTHER connected user's caret + selection on top of the
 * editable. Positions come from @slate-yjs (which resolves each client's
 * relative selection stored in Yjs awareness into DOM rects); colours/names
 * come from the identity each client publishes into awareness `data`
 * (see presence-identity.ts / yjs-kit.tsx).
 *
 * Mounted via the YjsPlugin `render.afterEditable` slot so it only exists
 * while the collaborative editor is on screen.
 */
export function RemoteCursorOverlay() {
  // Only render once the provider is connected — before that there are no
  // remote awareness states and the hook would observe a detached awareness.
  const isConnected = usePluginOption(YjsPlugin, '_isConnected');
  if (!isConnected) return null;
  return <RemoteCursorOverlayContent />;
}

function RemoteCursorOverlayContent() {
  const containerRef = React.useRef<HTMLDivElement>(
    null,
  ) as React.RefObject<HTMLDivElement>;
  const [cursors] = useRemoteCursorOverlayPositions<CursorIdentity>({
    containerRef,
  });

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      {/* Name labels start visible and fade out after a pause; re-keying the
          label on caret movement restarts the animation (no state needed). */}
      <style>{`@keyframes rc-label-fade { to { opacity: 0; } }`}</style>
      {cursors.map((cursor) => (
        <RemoteSelection key={cursor.clientId} {...cursor} />
      ))}
    </div>
  );
}

function RemoteSelection({
  caretPosition,
  data,
  selectionRects,
}: CursorOverlayData<CursorIdentity>) {
  if (!data) return null;
  const selectionStyle: React.CSSProperties = {
    // Fall back to a neutral highlight if the peer published no colour.
    backgroundColor: data.color ? `${data.color}33` : 'rgba(124,58,237,0.2)',
  };

  return (
    <React.Fragment>
      {selectionRects.map((position, i) => (
        <div
          key={i}
          className="pointer-events-none absolute"
          style={{ ...selectionStyle, ...position }}
        />
      ))}
      {caretPosition && <Caret caretPosition={caretPosition} data={data} />}
    </React.Fragment>
  );
}

function Caret({
  caretPosition,
  data,
}: Pick<CursorOverlayData<CursorIdentity>, 'caretPosition' | 'data'>) {
  const caretStyle: React.CSSProperties = {
    ...caretPosition,
    background: data?.color ?? '#7C3AED',
  };

  return (
    <div
      className="pointer-events-none absolute w-0.5"
      style={caretStyle}
    >
      <div
        // Re-key on position so the fade restarts whenever the caret moves.
        key={`${caretPosition?.top ?? 0}-${caretPosition?.left ?? 0}`}
        className={cn(
          'absolute top-0 left-0 -translate-y-full rounded rounded-bl-none px-1.5 py-0.5 font-ui-xs text-ui-xs whitespace-nowrap text-white',
        )}
        style={{
          background: data?.color ?? '#7C3AED',
          animation: 'rc-label-fade 0.3s ease-out 2s forwards',
        }}
      >
        {data?.name ?? 'Anonymous'}
      </div>
    </div>
  );
}
