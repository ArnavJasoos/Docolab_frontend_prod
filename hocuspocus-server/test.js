// hocuspocus-server/test.js
// Unit tests for auth and storage logic.
// Run: node --test test.js

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const SECRET = 'test-secret-for-unit-tests';

// ─────────────────────────────────────────────────────────────────────────────
// verifyToken logic (mirrors auth.js without DB)
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors auth.js::verifyToken — the FastAPI token carries ONLY { sub, exp }.
function verifyTokenSync(token, secret) {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!payload.sub) return null;
    return { id: payload.sub };
  } catch {
    return null;
  }
}

describe('verifyToken', () => {
  test('returns { id } from the sub claim for a valid HS256 token', () => {
    const token = jwt.sign({ sub: 'user-abc' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    const result = verifyTokenSync(token, SECRET);
    assert.deepEqual(result, { id: 'user-abc' });
  });

  test('returns null for an expired token', () => {
    const token = jwt.sign({ sub: 'user-abc' }, SECRET, { expiresIn: 0 });
    const result = verifyTokenSync(token, SECRET);
    assert.equal(result, null);
  });

  test('returns null when signed with wrong secret', () => {
    const token = jwt.sign({ sub: 'user-abc' }, 'wrong-secret');
    const result = verifyTokenSync(token, SECRET);
    assert.equal(result, null);
  });

  test('returns null for a malformed token string', () => {
    const result = verifyTokenSync('not.a.valid.token', SECRET);
    assert.equal(result, null);
  });

  test('returns null when the sub claim is missing', () => {
    const token = jwt.sign({ foo: 'bar' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    const result = verifyTokenSync(token, SECRET);
    assert.equal(result, null);
  });

  test('ignores a token signed with a non-HS256 algorithm (alg confusion)', () => {
    const token = jwt.sign({ sub: 'user-abc' }, SECRET, { algorithm: 'HS512' });
    const result = verifyTokenSync(token, SECRET);
    assert.equal(result, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getUserRole hierarchy walk (mirrors auth_service.py::authorize):
//   document → its folder → parent folders, first assignment wins, else null
//   (no access — the connection is rejected, matching the REST 403).
// We model the DB as a sequence of scopes; the walker returns the first hit.
// ─────────────────────────────────────────────────────────────────────────────

// rowsByScope: Map "<scopeType>:<scopeId>" → role name (an assignment)
// parents: Map "folder:<id>" → parentFolderId | null ; docFolder: doc → folderId
function walkRole(documentId, { assignment, docFolder, folderParent }) {
  let scopeType = 'document';
  let scopeId = documentId;
  for (let depth = 0; depth < 64 && scopeId; depth++) {
    const hit = assignment.get(`${scopeType}:${scopeId}`);
    if (hit) return hit;
    if (scopeType === 'document') {
      if (!docFolder.has(scopeId)) break;
      scopeType = 'folder';
      scopeId = docFolder.get(scopeId);
    } else {
      const parent = folderParent.get(scopeId);
      if (!parent) break;
      scopeId = parent;
    }
  }
  return null;
}

describe('getUserRole hierarchy walk', () => {
  const docFolder = new Map([['doc1', 'fA']]);          // doc1 lives in folder fA
  const folderParent = new Map([['fA', 'fRoot'], ['fRoot', null]]); // fA → fRoot → root

  test('document-scoped assignment wins', () => {
    const assignment = new Map([['document:doc1', 'editor']]);
    assert.equal(walkRole('doc1', { assignment, docFolder, folderParent }), 'editor');
  });

  test('falls back to the immediate folder assignment', () => {
    const assignment = new Map([['folder:fA', 'suggester']]);
    assert.equal(walkRole('doc1', { assignment, docFolder, folderParent }), 'suggester');
  });

  test('inherits a parent-folder assignment when nearer scopes are empty', () => {
    const assignment = new Map([['folder:fRoot', 'owner']]);
    assert.equal(walkRole('doc1', { assignment, docFolder, folderParent }), 'owner');
  });

  test('document scope takes precedence over folder scope', () => {
    const assignment = new Map([
      ['document:doc1', 'viewer'],
      ['folder:fA', 'owner'],
    ]);
    assert.equal(walkRole('doc1', { assignment, docFolder, folderParent }), 'viewer');
  });

  test('nearer folder takes precedence over parent folder', () => {
    const assignment = new Map([
      ['folder:fA', 'editor'],
      ['folder:fRoot', 'owner'],
    ]);
    assert.equal(walkRole('doc1', { assignment, docFolder, folderParent }), 'editor');
  });

  test('resolves to null (no access) when no assignment exists anywhere', () => {
    assert.equal(walkRole('doc1', { assignment: new Map(), docFolder, folderParent }), null);
  });

  test('resolves to null (no access) when the document is not found', () => {
    assert.equal(
      walkRole('ghost', { assignment: new Map(), docFolder, folderParent }),
      null
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// storage.js type conversion (Uint8Array ↔ Buffer)
// ─────────────────────────────────────────────────────────────────────────────

describe('storage type conversion', () => {
  test('Buffer.from(Uint8Array) preserves bytes', () => {
    const input = new Uint8Array([0x01, 0x02, 0xff, 0x00]);
    const buf = Buffer.from(input);
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual([...buf], [...input]);
  });

  test('new Uint8Array(Buffer) preserves bytes', () => {
    const buf = Buffer.from([0x10, 0x20, 0x30]);
    const arr = new Uint8Array(buf);
    assert.ok(arr instanceof Uint8Array);
    assert.deepEqual([...arr], [0x10, 0x20, 0x30]);
  });

  test('null yjs_state maps to null return (new document)', () => {
    const row = { yjs_state: null };
    const result = row.yjs_state ? new Uint8Array(row.yjs_state) : null;
    assert.equal(result, null);
  });

  test('non-null yjs_state maps to Uint8Array', () => {
    const row = { yjs_state: Buffer.from([1, 2, 3]) };
    const result = row.yjs_state ? new Uint8Array(row.yjs_state) : null;
    assert.ok(result instanceof Uint8Array);
    assert.deepEqual([...result], [1, 2, 3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// READ_ONLY_ROLES guard
// ─────────────────────────────────────────────────────────────────────────────

// Real role set (roles table): owner / approver / editor / suggester / viewer.
describe('READ_ONLY_ROLES', () => {
  const READ_ONLY_ROLES = new Set(['viewer']);

  test('viewer is read-only', () => {
    assert.ok(READ_ONLY_ROLES.has('viewer'));
  });

  for (const role of ['owner', 'approver', 'editor', 'suggester']) {
    test(`${role} can push edits (not read-only)`, () => {
      assert.ok(!READ_ONLY_ROLES.has(role));
    });
  }

  test('an unknown role defaults to editable only if explicitly absent', () => {
    // getUserRole never returns unknown names, but guard the set semantics.
    assert.ok(!READ_ONLY_ROLES.has('totally-unknown'));
  });
});
