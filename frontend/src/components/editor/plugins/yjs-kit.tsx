'use client';

import { YjsPlugin } from '@platejs/yjs/react';

import { getFreshToken } from '@/lib/api/client';
import type { CursorIdentity } from '@/lib/presence-identity';
import { RemoteCursorOverlay } from '@/components/ui/remote-cursor-overlay';

const COLLAB_URL =
  process.env.NEXT_PUBLIC_COLLAB_URL ?? 'ws://localhost:1234';

/**
 * Build the YjsPlugin for a specific document.
 * Call inside usePlateEditor — the component must be client-side only.
 *
 * The Hocuspocus provider's `token` is passed as an ASYNC FUNCTION: the
 * provider invokes it on every (re)connect, and getFreshToken() silently
 * rotates an expired/expiring access token through the refresh flow first.
 * Without this, any reconnect after the short-lived (~60m) access token
 * expired failed auth permanently — the "randomly disconnected while editing
 * and never comes back" bug.
 *
 * `cursors.data` publishes the local user's identity (colour + name) into Yjs
 * awareness so other clients can render this user's caret and presence avatar;
 * `render.afterEditable` mounts the overlay that actually draws the remote
 * carets/selections.
 *
 * @param docId - document UUID, used as the Hocuspocus document name
 * @param cursorData - the local user's awareness identity (see presence-identity)
 */
export function createYjsPlugin(docId: string, cursorData: CursorIdentity) {
  return YjsPlugin.configure({
    render: {
      afterEditable: RemoteCursorOverlay,
    },
    options: {
      cursors: { data: cursorData },
      providers: [
        {
          type: 'hocuspocus' as const,
          options: {
            url: COLLAB_URL,
            name: docId,
            token: async () => (await getFreshToken()) ?? '',
          },
        },
      ],
    },
  });
}
