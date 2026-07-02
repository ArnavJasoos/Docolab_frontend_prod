// hocuspocus-server/auth.js
// JWT verification + role resolution.
// Uses the same JWT_SECRET and role/assignment tables as the FastAPI backend.

import jwt from "jsonwebtoken";
import { query } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "changeme-use-same-secret-as-fastapi";

// ─────────────────────────────────────────────────────────────────────────────
// verifyToken(token) → { id } | null
//
// Mirrors FastAPI's create_access_token (app/core/security.py), which encodes
// ONLY { "sub": user_id, "exp": ... } with HS256. There is no org_id or email
// claim, so we deliberately read just `sub`. The same SECRET_KEY must be shared.
// ─────────────────────────────────────────────────────────────────────────────
export async function verifyToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return { id: payload.sub };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getUserRole(userId, documentId) → role name string | null
//
// Mirrors app/services/auth_service.py::resolve_role EXACTLY — keep the two in
// sync. The walk is: document → its folder → parent folders → ORG (terminal).
// The org fall-through is essential: an org-admin holds only an org-scoped
// assignment, so without it they'd be denied here (read-only) while the REST API
// grants them access — a split-brain between the two networking layers.
//   - Matches assignments by (user_id, scope_type, scope_id) only (single-org v1,
//     like the backend — no org_id filter on the assignment lookup).
//   - Returns null when no assignment is found anywhere up the hierarchy. The
//     server REJECTS such connections: resolve_role denies these users on the
//     REST side, and defaulting to "viewer" here leaked every document's
//     content to any authenticated user who guessed/knew its UUID.
// ─────────────────────────────────────────────────────────────────────────────
export async function getUserRole(userId, documentId) {
  let scopeType = "document";
  let scopeId = documentId;

  // Bounded walk up the scope hierarchy (guard against cycles / very deep trees).
  for (let depth = 0; depth < 64 && scopeId; depth++) {
    const assignment = await query(
      `SELECT r.name
         FROM assignments a
         JOIN roles r ON r.id = a.role_id
        WHERE a.user_id = $1
          AND a.scope_type = $2
          AND a.scope_id = $3
        LIMIT 1`,
      [userId, scopeType, scopeId]
    );
    if (assignment.rows.length > 0) return assignment.rows[0].name;

    // No assignment at this scope — climb one level toward the org root.
    if (scopeType === "document") {
      const doc = await query(
        "SELECT folder_id FROM documents WHERE id = $1 LIMIT 1",
        [scopeId]
      );
      if (doc.rows.length === 0) break;
      // folder_id may be NULL for a root-level document (matches resolve_role:
      // a null folder ends the walk -> viewer).
      scopeType = "folder";
      scopeId = doc.rows[0].folder_id;
    } else if (scopeType === "folder") {
      const folder = await query(
        "SELECT parent_folder_id, org_id FROM folders WHERE id = $1 LIMIT 1",
        [scopeId]
      );
      if (folder.rows.length === 0) break;
      if (folder.rows[0].parent_folder_id) {
        scopeId = folder.rows[0].parent_folder_id;        // climb to parent folder
      } else {
        scopeType = "org";                                // root folder -> org scope
        scopeId = folder.rows[0].org_id;                  // (the resolve_role fix)
      }
    } else {
      break; // "org" is terminal — it was already queried at the top of the loop
    }
  }

  // No assignment found anywhere up the hierarchy — no access.
  return null;
}
