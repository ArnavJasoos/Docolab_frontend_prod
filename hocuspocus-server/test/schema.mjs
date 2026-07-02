// test/schema.mjs
// Spins up an in-memory PostgreSQL (pg-mem) with a faithful subset of the real
// Docolab schema and a realistic seed graph, then returns a pg-compatible Pool.
//
// The schema mirrors backend/app/models/database_models.py for exactly the
// tables our collaboration server touches: roles, assignments, folders,
// documents. UUID columns are modelled as `text` (our SQL never casts types),
// which keeps the seed readable while exercising the identical query shapes.

import { newDb } from "pg-mem";

// Stable ids for the seed graph so tests can reference them by name.
export const ids = {
  org: "org-1",
  roles: {
    owner: "role-owner",
    approver: "role-approver",
    editor: "role-editor",
    suggester: "role-suggester",
    viewer: "role-viewer",
  },
  users: {
    owner: "user-owner",
    editor: "user-editor",
    viewer: "user-viewer",
    suggester: "user-suggester",
    none: "user-none", // has no assignment anywhere
    parentOnly: "user-parent", // granted only on the root folder
    precedence: "user-precedence", // doc-scoped editor + folder-scoped owner
    nearest: "user-nearest", // child-folder editor + root-folder owner
  },
  folders: {
    root: "folder-root", // parent_folder_id = NULL
    child: "folder-child", // parent = root
    other: "folder-other", // parent = NULL, unrelated tree
  },
  docs: {
    inChild: "doc-in-child", // lives in folder-child  (main subject)
    inRoot: "doc-in-root", // lives in folder-root   (used for storage tests)
    other: "doc-other", // lives in folder-other
    orphan: "doc-orphan", // points at a folder that does not exist
  },
};

export async function createTestDb() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE roles (
        id      text PRIMARY KEY,
        org_id  text NOT NULL,
        name    text NOT NULL
      );
      CREATE TABLE assignments (
        id          text PRIMARY KEY,
        org_id      text NOT NULL,
        user_id     text NOT NULL,
        role_id     text NOT NULL,
        scope_type  text NOT NULL,
        scope_id    text NOT NULL
      );
      CREATE TABLE folders (
        id               text PRIMARY KEY,
        org_id           text NOT NULL,
        parent_folder_id text,
        name             text NOT NULL
      );
      CREATE TABLE documents (
        id          text PRIMARY KEY,
        org_id      text NOT NULL,
        folder_id   text NOT NULL,
        title       text NOT NULL,
        yjs_doc_key text NOT NULL,
        status      text NOT NULL DEFAULT 'working',
        yjs_state   bytea,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { org, roles, users, folders, docs } = ids;

    // Roles (the fixed five, per the roles table docstring).
    for (const [name, id] of Object.entries(roles)) {
      await c.query(`INSERT INTO roles (id, org_id, name) VALUES ($1,$2,$3)`, [id, org, name]);
    }

    // Folders: root → child ; other (separate tree).
    await c.query(
      `INSERT INTO folders (id, org_id, parent_folder_id, name) VALUES
         ($1,$2,NULL,'Root'),
         ($3,$2,$1,'Child'),
         ($4,$2,NULL,'Other')`,
      [folders.root, org, folders.child, folders.other]
    );

    // Documents.
    await c.query(
      `INSERT INTO documents (id, org_id, folder_id, title, yjs_doc_key) VALUES
         ($1,$5,$2,'In Child','key-in-child'),
         ($3,$5,$6,'In Root','key-in-root'),
         ($4,$5,$7,'Other','key-other'),
         ($8,$5,'folder-missing','Orphan','key-orphan')`,
      [docs.inChild, folders.child, docs.inRoot, docs.other, org, folders.root, folders.other, docs.orphan]
    );

    // Assignments — exercise every resolution path.
    const A = (id, user, role, scopeType, scopeId) =>
      c.query(
        `INSERT INTO assignments (id, org_id, user_id, role_id, scope_type, scope_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, org, user, role, scopeType, scopeId]
      );

    await A("a1", users.editor, roles.editor, "document", docs.inChild); // doc-scoped
    await A("a2", users.viewer, roles.viewer, "document", docs.inChild); // doc-scoped viewer
    await A("a3", users.suggester, roles.suggester, "folder", folders.child); // folder-scoped
    await A("a4", users.parentOnly, roles.owner, "folder", folders.root); // parent-folder inheritance

    // precedence: doc-scoped editor AND folder-scoped owner → doc must win.
    await A("a5", users.precedence, roles.editor, "document", docs.inChild);
    await A("a6", users.precedence, roles.owner, "folder", folders.child);

    // nearest: child-folder editor AND root-folder owner → child (nearer) wins.
    await A("a7", users.nearest, roles.editor, "folder", folders.child);
    await A("a8", users.nearest, roles.owner, "folder", folders.root);

    // owner: doc-scoped owner (connections without ANY grant are now rejected,
    // so every fixture user that must connect needs a real assignment).
    await A("a9", users.owner, roles.owner, "document", docs.inChild);
  } finally {
    c.release();
  }

  return { db, pool };
}
