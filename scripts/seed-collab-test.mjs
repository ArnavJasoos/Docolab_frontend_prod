// scripts/seed-collab-test.mjs
// One-shot helper to provision a real document for testing live collaboration.
//
// It talks to the running FastAPI backend (NOT mocks) to:
//   1. sign up / log in two users (Alice = owner, Bob = editor)
//   2. create a folder and a document as Alice (Alice auto-becomes owner)
//   3. grant Bob the "editor" role on that document
//   4. print both JWTs, the real document UUID, and ready-to-paste browser steps
//
// Prereq: FastAPI running on http://localhost:8000 (override with API_BASE).
//
// Usage:
//   node scripts/seed-collab-test.mjs
//
// Then open two browser windows, paste the printed localStorage snippet into
// each (one for Alice, one for Bob), and navigate to the printed editor URL.

const API = (process.env.API_BASE ?? "http://localhost:8000/api").replace(/\/$/, "");
const FRONTEND = (process.env.FRONTEND_BASE ?? "http://localhost:3000").replace(/\/$/, "");

const USERS = {
  alice: { email: "alice@example.com", password: "password123", display_name: "Alice" },
  bob: { email: "bob@example.com", password: "password123", display_name: "Bob" },
};

async function call(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const detail = data?.detail ?? text ?? res.statusText;
    const err = new Error(`${method} ${path} → ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Sign up; if the email already exists, fall back to login.
async function signUpOrLogin({ email, password, display_name }) {
  try {
    const r = await call("/auth/signup", { method: "POST", body: { email, password, display_name } });
    return r;
  } catch (e) {
    if (e.status === 409) {
      return call("/auth/login", { method: "POST", body: { email, password } });
    }
    throw e;
  }
}

async function main() {
  console.log(`API base: ${API}\n`);

  // 1. Users
  const alice = await signUpOrLogin(USERS.alice);
  const bob = await signUpOrLogin(USERS.bob);
  console.log(`Alice: ${alice.user.id}`);
  console.log(`Bob:   ${bob.user.id}\n`);

  // 2. Folder + document as Alice (Alice becomes document owner automatically)
  const folder = await call("/folders", {
    method: "POST",
    token: alice.token,
    body: { name: "Collab Test" },
  });
  const docResp = await call("/documents", {
    method: "POST",
    token: alice.token,
    body: { folder_id: folder.id, title: "Realtime Test Doc" },
  });
  const docId = docResp.id;
  console.log(`Folder:   ${folder.id}`);
  console.log(`Document: ${docId}  (yjs_doc_key=${docResp.yjs_doc_key})\n`);

  // 3. Grant Bob the editor role on the document
  const roles = (await call("/roles", { token: alice.token })).roles;
  const editorRole = roles.find((r) => r.name === "editor");
  if (!editorRole) throw new Error("editor role not found — is the backend seeded?");
  try {
    await call("/assignments", {
      method: "POST",
      token: alice.token,
      body: {
        user_id: bob.user.id,
        role_id: editorRole.id,
        scope_type: "document",
        scope_id: docId,
      },
    });
    console.log(`Granted Bob editor on the document.\n`);
  } catch (e) {
    if (e.status === 409) console.log(`Bob already has an assignment (ok).\n`);
    else throw e;
  }

  // 4. Print the test steps
  const url = `${FRONTEND}/editor?doc=${docId}`;
  const line = "=".repeat(72);
  console.log(line);
  console.log("READY — test live collaboration in two browser windows:");
  console.log(line);
  console.log(`\nEditor URL (both windows):\n  ${url}\n`);
  console.log("Window 1 (Alice) — paste in DevTools console, then load the URL:");
  console.log(`  localStorage.setItem('docflow.token', '${alice.token}')\n`);
  console.log("Window 2 (Bob) — use a different browser or an incognito window:");
  console.log(`  localStorage.setItem('docflow.token', '${bob.token}')\n`);
  console.log("Type in one window — it should appear in the other within ~100ms.");
  console.log("Reload either window — content persists (loaded from Postgres).");
  console.log(line);
}

main().catch((e) => {
  console.error("\nSEED FAILED:", e.message);
  console.error("Is FastAPI running on", API, "?");
  process.exit(1);
});
