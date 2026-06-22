"""
Rigorous tests for the RBAC enforcement + audit-log features.

Run (Command Prompt, from backend\, server running against a DB):
    python test_rbac_audit.py

Covers:
  RBAC guards (foundation modules):
    - bootstrap-safe: ROOT folder creation is open; NESTED requires parent rights
    - create/patch/delete document & folder require the right permission on scope
    - a stranger (no role) is blocked (403) on someone else's folder/doc
    - the owner (creator-owns) is allowed (201/200/204)
    - move-into-folder-you-can't-edit is blocked
    - users: self-edit allowed, editing others forbidden (self-only rule)
  Audit:
    - state-changing actions append audit_log rows (document_create,
      suggestion_create, resolve_suggestion visible via GET /documents/:id/audit)
    - audit read is guarded by can_view_history (stranger -> 403)
    - audit is append-only (no DELETE on the audit path -> 405)
"""

import sys
import uuid
import httpx

BASE = "http://127.0.0.1:8000/api"
RANDOM_ID = str(uuid.uuid4())
_fail = []


def check(name, ok, extra=""):
    print(f"  [{'OK ' if ok else 'XX '}] {name}" + (f"  -> {extra}" if extra else ""))
    if not ok:
        _fail.append(name)


def signup(c, label):
    em = f"{label}_{uuid.uuid4().hex[:8]}@t.com"
    r = c.post("/auth/signup", json={"email": em, "password": "secret123", "display_name": label})
    if r.status_code != 201:
        print("FATAL signup:", r.status_code, r.text); sys.exit(1)
    return r.json()["user"]["id"], r.json()["token"]


def main():
    with httpx.Client(base_url=BASE, timeout=20) as c:
        alice_id, atok = signup(c, "alice")
        bob_id, btok = signup(c, "bob")
        A = {"Authorization": f"Bearer {atok}"}
        B = {"Authorization": f"Bearer {btok}"}

        # ---- Bootstrap + creator-owns -------------------------------------
        print("\n[RBAC] bootstrap + creator-owns")
        r = c.post("/folders", json={"name": "Alice root", "parent_folder_id": None}, headers=A)
        check("Alice creates ROOT folder (open) -> 201", r.status_code == 201, r.status_code)
        fa = r.json()["id"]
        r = c.post("/documents", json={"folder_id": fa, "title": "A doc"}, headers=A)
        check("Alice (owner) creates doc in her folder -> 201", r.status_code == 201, r.status_code)
        da = r.json()["id"]
        r = c.post("/folders", json={"name": "Bob root", "parent_folder_id": None}, headers=B)
        check("Bob creates his OWN root folder (open) -> 201", r.status_code == 201, r.status_code)
        fb = r.json()["id"]

        # ---- Stranger (Bob) blocked on Alice's folder/doc -----------------
        print("\n[RBAC] stranger is blocked (403)")
        r = c.post("/documents", json={"folder_id": fa, "title": "x"}, headers=B)
        check("Bob create doc in Alice's folder -> 403", r.status_code == 403, r.status_code)
        r = c.post("/folders", json={"name": "sub", "parent_folder_id": fa}, headers=B)
        check("Bob create NESTED folder under Alice's -> 403", r.status_code == 403, r.status_code)
        r = c.patch(f"/documents/{da}", json={"title": "hijack"}, headers=B)
        check("Bob patch Alice's doc -> 403", r.status_code == 403, r.status_code)
        r = c.delete(f"/documents/{da}", headers=B)
        check("Bob delete Alice's doc -> 403", r.status_code == 403, r.status_code)
        r = c.patch(f"/folders/{fa}", json={"name": "hijack"}, headers=B)
        check("Bob patch Alice's folder -> 403", r.status_code == 403, r.status_code)
        r = c.delete(f"/folders/{fa}", headers=B)
        check("Bob delete Alice's folder -> 403", r.status_code == 403, r.status_code)

        # ---- Owner (Alice) allowed ----------------------------------------
        print("\n[RBAC] owner is allowed")
        r = c.post("/folders", json={"name": "sub", "parent_folder_id": fa}, headers=A)
        check("Alice create NESTED folder under her own -> 201", r.status_code == 201, r.status_code)
        sub = r.json()["id"]
        r = c.patch(f"/documents/{da}", json={"title": "renamed"}, headers=A)
        check("Alice patch her doc -> 200", r.status_code == 200, r.status_code)
        # move doc into a folder Alice can't edit (Bob's) -> 403
        r = c.patch(f"/documents/{da}", json={"folder_id": fb}, headers=A)
        check("Alice move doc into Bob's folder -> 403", r.status_code == 403, r.status_code)

        # ---- Users: self-only ---------------------------------------------
        print("\n[RBAC] user self-edit only")
        r = c.patch(f"/users/{alice_id}", json={"display_name": "Alice A"}, headers=A)
        check("Alice edits her OWN profile -> 200", r.status_code == 200, r.status_code)
        r = c.patch(f"/users/{bob_id}", json={"display_name": "hijack"}, headers=A)
        check("Alice edits Bob's profile -> 403", r.status_code == 403, r.status_code)
        r = c.patch(f"/users/{bob_id}", json={"display_name": "Bob B"}, headers=B)
        check("Bob edits his OWN profile -> 200", r.status_code == 200, r.status_code)

        # ---- Audit --------------------------------------------------------
        print("\n[AUDIT] state changes are logged")
        # generate some auditable actions on Alice's doc (she's owner)
        r = c.post(f"/documents/{da}/suggestions",
                   json={"type": "insert", "anchor": {"p": 1}, "origin": "human"}, headers=A)
        check("Alice create suggestion -> 201", r.status_code == 201, r.status_code)
        sid = r.json().get("id")
        if sid:
            r = c.post(f"/suggestions/{sid}/accept", json={}, headers=A)
            check("Alice accept suggestion -> 200", r.status_code == 200, r.status_code)
        r = c.get(f"/documents/{da}/audit", headers=A)
        check("Alice (owner) read audit -> 200", r.status_code == 200, r.status_code)
        actions = {e["action"] for e in r.json()["entries"]} if r.status_code == 200 else set()
        check("audit contains document_create", "document_create" in actions, sorted(actions))
        check("audit contains suggestion_create", "suggestion_create" in actions)
        check("audit contains resolve_suggestion", "resolve_suggestion" in actions)
        check("audit rows carry actor + action + created_at",
              r.status_code == 200 and all({"actor_id", "action", "created_at"} <= e.keys() for e in r.json()["entries"]))

        # audit access control + append-only
        r = c.get(f"/documents/{da}/audit", headers=B)
        check("Bob (no role) read audit -> 403", r.status_code == 403, r.status_code)
        r = c.request("DELETE", f"/documents/{da}/audit", headers=A)
        check("DELETE on audit path -> 405 (append-only)", r.status_code == 405, r.status_code)

    print("\n" + "=" * 56)
    if _fail:
        print(f"FAILED ({len(_fail)}): " + ", ".join(_fail)); print("=" * 56); sys.exit(1)
    print("ALL RBAC + AUDIT CHECKS PASSED"); print("=" * 56)


if __name__ == "__main__":
    main()
