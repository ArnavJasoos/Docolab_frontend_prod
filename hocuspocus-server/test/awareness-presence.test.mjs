// test/awareness-presence.test.mjs
// Validates the LIVE PRESENCE + REMOTE CURSOR mechanism the frontend relies on:
// each client publishes its identity into Yjs awareness `data` (see the
// frontend's presence-identity.ts / yjs-kit.tsx / use-presence.ts), and every
// other connected client must see that state through the REAL server.
//
// use-presence.ts reads exactly `awareness.getStates()` → `state.data` →
// { userId, name, hue }. These tests assert that round-trip over real
// WebSockets ↔ buildServer ↔ pg-mem.

import { JWT_SECRET } from "./_setup-env.mjs"; // must precede server/auth import
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { WebSocket } from "ws";

import { setPool } from "../db.js";
import { buildServer } from "../server.js";
import { createTestDb, ids } from "./schema.mjs";

let nextPort = 14300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (sub) => jwt.sign({ sub }, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });

async function harness() {
  const { pool } = await createTestDb();
  setPool(pool);
  const port = nextPort++;
  const server = buildServer({ port, quiet: true });
  await server.listen();

  const clients = [];
  function connect(docId, token) {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://localhost:${port}`,
      name: docId,
      document: doc,
      token,
      WebSocketPolyfill: WebSocket,
    });
    const handle = { doc, provider };
    clients.push(handle);
    return handle;
  }

  async function teardown() {
    for (const c of clients) {
      try { c.provider.destroy(); } catch {}
    }
    await sleep(50);
    await server.destroy();
    setPool(null);
  }

  return { connect, teardown };
}

// Collect the remote `data` payloads visible to a client (excludes its own state).
function remoteIdentities(provider) {
  const out = [];
  const localId = provider.document.clientID;
  for (const [clientId, state] of provider.awareness.getStates()) {
    if (clientId === localId) continue;
    if (state?.data?.userId) out.push(state.data);
  }
  return out;
}

describe("live presence / cursor identity over awareness", () => {
  test("two editors each see the other's identity (userId/name/hue)", async () => {
    const h = await harness();
    try {
      const a = h.connect(ids.docs.inChild, sign(ids.users.editor));
      const b = h.connect(ids.docs.inChild, sign(ids.users.owner));
      await sleep(500);

      a.provider.awareness.setLocalStateField("data", {
        userId: "user-a", name: "Alice", hue: "violet",
      });
      b.provider.awareness.setLocalStateField("data", {
        userId: "user-b", name: "Bob", hue: "teal",
      });
      await sleep(400);

      const seenByA = remoteIdentities(a.provider);
      const seenByB = remoteIdentities(b.provider);

      assert.equal(seenByA.length, 1, "A should see exactly one peer");
      assert.equal(seenByA[0].userId, "user-b");
      assert.equal(seenByA[0].name, "Bob");
      assert.equal(seenByA[0].hue, "teal");

      assert.equal(seenByB.length, 1, "B should see exactly one peer");
      assert.equal(seenByB[0].userId, "user-a");
      assert.equal(seenByB[0].name, "Alice");
      assert.equal(seenByB[0].hue, "violet");
    } finally {
      await h.teardown();
    }
  });

  test("a viewer (read-only) still appears in presence", async () => {
    // Read-only gates document WRITES, not awareness — viewers must still show
    // up in the presence stack so editors know who is watching.
    const h = await harness();
    try {
      const viewer = h.connect(ids.docs.inChild, sign(ids.users.viewer));
      const editor = h.connect(ids.docs.inChild, sign(ids.users.editor));
      await sleep(500);

      viewer.provider.awareness.setLocalStateField("data", {
        userId: "viewer-1", name: "Vera", hue: "rose",
      });
      editor.provider.awareness.setLocalStateField("data", {
        userId: "editor-1", name: "Ed", hue: "amber",
      });
      await sleep(400);

      const seenByEditor = remoteIdentities(editor.provider);
      assert.ok(
        seenByEditor.some((d) => d.userId === "viewer-1"),
        "the editor must see the viewer in presence"
      );
    } finally {
      await h.teardown();
    }
  });

  test("a disconnecting client is removed from presence", async () => {
    const h = await harness();
    try {
      const a = h.connect(ids.docs.inChild, sign(ids.users.editor));
      const b = h.connect(ids.docs.inChild, sign(ids.users.owner));
      await sleep(500);

      a.provider.awareness.setLocalStateField("data", {
        userId: "stay", name: "Stay", hue: "sky",
      });
      b.provider.awareness.setLocalStateField("data", {
        userId: "leave", name: "Leave", hue: "lime",
      });
      await sleep(400);
      assert.equal(remoteIdentities(a.provider).length, 1, "A sees B before leave");

      b.provider.destroy(); // B leaves
      await sleep(500);

      const seenByA = remoteIdentities(a.provider);
      assert.ok(
        !seenByA.some((d) => d.userId === "leave"),
        "B must drop out of A's presence after disconnect"
      );
    } finally {
      await h.teardown();
    }
  });
});
