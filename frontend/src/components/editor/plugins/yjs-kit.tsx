'use client';

import { YjsPlugin } from '@platejs/yjs/react';

import { getToken } from '@/lib/api/client';
import type { CursorIdentity } from '@/lib/presence-identity';

const COLLAB_URL =
  process.env.NEXT_PUBLIC_COLLAB_URL ?? 'ws://localhost:1234';

/**
 * Build the YjsPlugin for a specific document.
 * Call inside usePlateEditor — the component must be client-side only.
 *
 * The Hocuspocus provider's `token` is passed as a FUNCTION (not a static
 * string): the provider invokes it on every (re)connect, so it always reads the
 * CURRENT access token from storage. This matters now that access tokens are
 * short-lived (~60m) and rotated by the REST refresh flow — a reconnect after a
 * rotation picks up the fresh token instead of failing auth with a stale one.
 *
 * `cursors.data` publishes the local user's identity (colour + name) into Yjs
 * awareness so other clients can render this user's caret and presence avatar.
 *
 * @param docId - document UUID, used as the Hocuspocus document name
 * @param cursorData - the local user's awareness identity (see presence-identity)
 */
export function createYjsPlugin(docId: string, cursorData: CursorIdentity) {
  return YjsPlugin.configure({
    options: {
      cursors: { data: cursorData },
      providers: [
        {
          type: 'hocuspocus' as const,
          options: {
            url: COLLAB_URL,
            name: docId,
            token: () => getToken() ?? '',
          },
        },
      ],
    },
  });
}
