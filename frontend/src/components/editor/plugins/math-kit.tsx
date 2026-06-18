'use client';

import dynamic from 'next/dynamic';

import { MathRules } from '@platejs/math';
import { EquationPlugin, InlineEquationPlugin } from '@platejs/math/react';

// KaTeX rendering lives in the equation node components. Keep the plugins
// registered for parsing/input rules, but load the renderer on demand so KaTeX
// is only pulled in when a document contains an equation.
const EquationElement = dynamic(
  () => import('@/components/ui/equation-node').then((m) => m.EquationElement),
  { ssr: false },
);
const InlineEquationElement = dynamic(
  () =>
    import('@/components/ui/equation-node').then(
      (m) => m.InlineEquationElement,
    ),
  { ssr: false },
);

export const MathKit = [
  InlineEquationPlugin.configure({
    inputRules: [MathRules.markdown({ variant: '$' })],
    node: {
      component: InlineEquationElement,
    },
  }),
  EquationPlugin.configure({
    inputRules: [MathRules.markdown({ on: 'break', variant: '$$' })],
    node: {
      component: EquationElement,
    },
  }),
];
