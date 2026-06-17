// src/mocks/browser.ts — MSW worker for the browser (dev + Playwright).
import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);
