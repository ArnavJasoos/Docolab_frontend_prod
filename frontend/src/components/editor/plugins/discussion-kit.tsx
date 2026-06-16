'use client';

import { createPlatePlugin } from 'platejs/react';

import { BlockDiscussion } from '@/components/ui/block-discussion';
import {
  CURRENT_USER_ID,
  SEED_DISCUSSIONS,
  USERS_MAP,
} from '@/lib/api/comments';

// Re-exported so existing consumers keep importing the type from here.
export type { TDiscussion } from '@/lib/api/comments';

const BLOCK_SUGGESTION_SELECTOR = '[data-block-suggestion="true"]';

const getTargetElement = (target: EventTarget | null) => {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;

  return null;
};

export const getDiscussionClickTarget = ({
  selector,
  target,
}: {
  selector: string;
  target: EventTarget | null;
}) => {
  const element = getTargetElement(target);

  if (!element) return null;

  return element.closest(selector) as HTMLElement | null;
};

export const getDiscussionBlockClickTarget = ({
  selector = BLOCK_SUGGESTION_SELECTOR,
  target,
}: {
  selector?: string;
  target: EventTarget | null;
}) =>
  getDiscussionClickTarget({
    selector,
    target,
  });

// Purely a UI store for discussions + users. Seed data comes from the comments
// API today; the backend hydrates it per-document via editor.setOption(...).
export const discussionPlugin = createPlatePlugin({
  key: 'discussion',
  options: {
    currentUserId: CURRENT_USER_ID,
    discussions: SEED_DISCUSSIONS,
    users: USERS_MAP,
  },
})
  .configure({
    render: { aboveNodes: BlockDiscussion },
  })
  .extendSelectors(({ getOption }) => ({
    currentUser: () => getOption('users')[getOption('currentUserId')],
    user: (id: string) => getOption('users')[id],
  }));

export const DiscussionKit = [discussionPlugin];
