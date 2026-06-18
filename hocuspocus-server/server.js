// hocuspocus-server/server.js
// Real-time collaboration server for Docolab (Hocuspocus v3).
//
// Responsibilities:
//   1. Authenticate each WebSocket connection using the same JWT the REST API issues
//   2. Load the Y.Doc for a document from PostgreSQL when the first client connects
//   3. Broadcast Yjs binary updates between all connected clients in real time
//   4. Persist the updated Y.Doc back to PostgreSQL (debounced)
//   5. Mark the connection read-only for viewer roles
//
// The REST API (FastAPI) never touches document content — it handles governance only.
// This server handles content only — it never touches governance.
//
// Hocuspocus v3 API notes (differs from v2):
//   - Use `new Server(config)` then `server.listen()`  (no static Server.configure)
//   - onAuthenticate receives `connectionConfig` (not `connection`); set
//     `connectionConfig.readOnly` and RETURN the value you want as `context`.
//   - All other hooks receive that returned `context` directly.

import "dotenv/config";
import { Server } from "@hocuspocus/server";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import { verifyToken, getUserRole } from "./auth.js";
import { loadDocument, storeDocument } from "./storage.js";

const PORT = parseInt(process.env.COLLAB_PORT ?? "1234", 10);

// Read-only roles — these users can receive updates but cannot push edits.
// Real role set (roles table): owner / approver / editor / suggester / viewer.
const READ_ONLY_ROLES = new Set(["viewer"]);

const server = new Server({
  port: PORT,
  timeout: 30000, // disconnect idle clients after 30s
  debounce: 2000, // wait 2s of inactivity before calling onStoreDocument
  maxDebounce: 10000, // always store within 10s even if the client keeps typing

  // ──────────────────────────────────────────────────────────────────────────
  // 1. AUTHENTICATE
  // Called once per WebSocket connection, before any document data is sent.
  // Throw → connection rejected. Return value becomes `context` for later hooks.
  // ──────────────────────────────────────────────────────────────────────────
  async onAuthenticate({ token, documentName, connectionConfig }) {
    if (!token) throw new Error("No token provided");

    const user = await verifyToken(token);
    if (!user) throw new Error("Invalid or expired token");

    // documentName is the document UUID (set from the frontend provider config)
    const role = await getUserRole(user.id, documentName);

    // Read-only connections can receive updates but cannot send edits.
    connectionConfig.readOnly = READ_ONLY_ROLES.has(role);

    console.log(
      `[auth] user=${user.id} doc=${documentName} role=${role} readOnly=${connectionConfig.readOnly}`
    );

    // Returned object is exposed as `context` in onConnect/onDisconnect/etc.
    return { user, role };
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 2. LOAD DOCUMENT
  // Called when the first client connects to a documentName and Hocuspocus has
  // no in-memory state. Apply the stored Yjs state vector to the in-memory
  // Y.Doc, or leave it blank for a brand-new document.
  // ──────────────────────────────────────────────────────────────────────────
  async onLoadDocument({ documentName, document }) {
    const stored = await loadDocument(documentName);
    if (stored) {
      applyUpdate(document, stored);
      console.log(`[load] doc=${documentName} bytes=${stored.byteLength}`);
    } else {
      console.log(`[load] doc=${documentName} new document`);
    }
    return document;
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 3. STORE DOCUMENT
  // Called after the debounce window when the document has been modified.
  // Serialises the full Y.Doc state and writes it to PostgreSQL.
  // ──────────────────────────────────────────────────────────────────────────
  async onStoreDocument({ documentName, document }) {
    const state = encodeStateAsUpdate(document);
    await storeDocument(documentName, state);
    console.log(`[store] doc=${documentName} bytes=${state.byteLength}`);
  },

  // ──────────────────────────────────────────────────────────────────────────
  // 4. CONNECT / DISCONNECT (logging only)
  // ──────────────────────────────────────────────────────────────────────────
  async onConnect({ documentName, context }) {
    console.log(`[connect] doc=${documentName} user=${context?.user?.id ?? "unknown"}`);
  },

  async onDisconnect({ documentName, context }) {
    console.log(`[disconnect] doc=${documentName} user=${context?.user?.id ?? "unknown"}`);
  },
});

server.listen();
console.log(`Hocuspocus listening on ws://localhost:${PORT}`);
