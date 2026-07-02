// test/auth-db.test.mjs
// Exercises the REAL getUserRole() and verifyToken() (auth.js) against an
// in-memory Postgres (pg-mem) seeded with the real schema. This validates the
// actual SQL — the document → folder → parent-folder hierarchy walk, scope
// precedence, and the safe viewer default — exactly as it would run on real PG.

import { JWT_SECRET } from "./_setup-env.mjs"; // must precede auth.js import
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import { setPool } from "../db.js";
import { verifyToken, getUserRole } from "../auth.js";
import { createTestDb, ids } from "./schema.mjs";

let pool;

before(async () => {
  ({ pool } = await createTestDb());
  setPool(pool);
});

after(async () => {
  setPool(null);
});

describe("getUserRole — real SQL against pg-mem", () => {
  test("document-scoped assignment wins (editor)", async () => {
    assert.equal(await getUserRole(ids.users.editor, ids.docs.inChild), "editor");
  });

  test("document-scoped viewer resolves to viewer", async () => {
    assert.equal(await getUserRole(ids.users.viewer, ids.docs.inChild), "viewer");
  });

  test("folder-scoped assignment applies when no doc grant (suggester)", async () => {
    assert.equal(await getUserRole(ids.users.suggester, ids.docs.inChild), "suggester");
  });

  test("parent-folder grant is inherited down to a nested document (owner)", async () => {
    // user-parent is granted owner ONLY on folder-root; doc lives in folder-child.
    assert.equal(await getUserRole(ids.users.parentOnly, ids.docs.inChild), "owner");
  });

  test("document scope takes precedence over folder scope", async () => {
    // user-precedence: editor @ document AND owner @ folder-child → editor wins.
    assert.equal(await getUserRole(ids.users.precedence, ids.docs.inChild), "editor");
  });

  test("nearer folder takes precedence over parent folder", async () => {
    // user-nearest: editor @ folder-child AND owner @ folder-root → editor wins.
    assert.equal(await getUserRole(ids.users.nearest, ids.docs.inChild), "editor");
  });

  test("no assignment anywhere → null (connection rejected)", async () => {
    assert.equal(await getUserRole(ids.users.none, ids.docs.inChild), null);
  });

  test("a user's grant on one doc does NOT leak to an unrelated doc", async () => {
    // user-editor only has a grant on doc-in-child, not doc-other.
    assert.equal(await getUserRole(ids.users.editor, ids.docs.other), null);
  });

  test("unknown document id → null (walk terminates safely)", async () => {
    assert.equal(await getUserRole(ids.users.editor, "no-such-doc"), null);
  });

  test("document pointing at a missing folder → null (no crash)", async () => {
    assert.equal(await getUserRole(ids.users.parentOnly, ids.docs.orphan), null);
  });

  test("parent-folder owner does NOT apply to a doc in a different tree", async () => {
    // doc-other is under folder-other (separate tree); user-parent has no path.
    assert.equal(await getUserRole(ids.users.parentOnly, ids.docs.other), null);
  });
});

describe("verifyToken — real HS256 verification", () => {
  const sign = (claims, opts = {}) =>
    jwt.sign(claims, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h", ...opts });

  test("valid token → { id } from sub", async () => {
    assert.deepEqual(await verifyToken(sign({ sub: "user-abc" })), { id: "user-abc" });
  });

  test("expired token → null", async () => {
    assert.equal(await verifyToken(sign({ sub: "x" }, { expiresIn: -10 })), null);
  });

  test("wrong secret → null", async () => {
    const t = jwt.sign({ sub: "x" }, "other-secret");
    assert.equal(await verifyToken(t), null);
  });

  test("missing sub → null", async () => {
    assert.equal(await verifyToken(sign({ foo: "bar" })), null);
  });

  test("non-HS256 algorithm (alg confusion) → null", async () => {
    const t = jwt.sign({ sub: "x" }, JWT_SECRET, { algorithm: "HS512" });
    assert.equal(await verifyToken(t), null);
  });
});

describe("verifyToken + getUserRole — combined gate", () => {
  test("authenticated editor resolves their editor role on the document", async () => {
    const token = jwt.sign({ sub: ids.users.editor }, JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const user = await verifyToken(token);
    assert.ok(user);
    assert.equal(await getUserRole(user.id, ids.docs.inChild), "editor");
  });
});
