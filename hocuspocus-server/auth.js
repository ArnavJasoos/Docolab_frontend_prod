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
// getUserRole(userId, documentId) → role name string
//
// Mirrors app/services/auth_service.py::authorize() exactly:
//   - Walks the scope hierarchy: document → its folder → parent folders,
//     stopping at the FIRST assignment found.
//   - Matches assignments by (user_id, scope_type, scope_id) only — the backend
//     does NOT filter by org_id, so neither do we.
//   - Returns "viewer" as a safe read-only default when no assignment is found.
// ─────────────────────────────────────────────────────────────────────────────
export async function getUserRole(userId, documentId) {
  let scopeType = "document";
  let scopeId = documentId;

  // Bounded walk up the folder tree (guard against cycles / very deep trees).
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

    // No assignment at this scope — climb one level toward the root.
    if (scopeType === "document") {
      const doc = await query(
        "SELECT folder_id FROM documents WHERE id = $1 LIMIT 1",
        [scopeId]
      );
      if (doc.rows.length === 0) break;
      scopeType = "folder";
      scopeId = doc.rows[0].folder_id;
    } else if (scopeType === "folder") {
      const folder = await query(
        "SELECT parent_folder_id FROM folders WHERE id = $1 LIMIT 1",
        [scopeId]
      );
      if (folder.rows.length === 0 || !folder.rows[0].parent_folder_id) break;
      scopeId = folder.rows[0].parent_folder_id;
    } else {
      break;
    }
  }

  // No assignment found anywhere up the hierarchy — safe read-only default.
  return "viewer";
}
