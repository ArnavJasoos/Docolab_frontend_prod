"use client";

// src/mocks/mock-provider.tsx
// Starts the MSW browser worker when NEXT_PUBLIC_API_MOCKING="enabled".
// When disabled (default / production) it renders children immediately and
// never imports msw, so there is zero runtime cost.
//
// While enabled, it blocks rendering until the worker is ready so that every
// request the app fires is intercepted against the locked contract.

import * as React from "react";

const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING === "enabled";

export function MockProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = React.useState(!MOCKING_ENABLED);

  React.useEffect(() => {
    if (!MOCKING_ENABLED) return;
    let active = true;
    (async () => {
      const { worker } = await import("./browser");
      await worker.start({ onUnhandledRequest: "bypass" });
      if (active) setReady(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!ready) return null;
  return <>{children}</>;
}
