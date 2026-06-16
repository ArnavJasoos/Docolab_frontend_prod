// src/mocks/server.ts — MSW server for Node (unit/integration tests).
//
// Usage in a test setup file:
//   import { server } from "@/mocks/server";
//   beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
//   afterEach(() => server.resetHandlers());
//   afterAll(() => server.close());
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
