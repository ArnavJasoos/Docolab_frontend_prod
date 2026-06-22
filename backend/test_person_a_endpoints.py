"""
End-to-end test for the Person A endpoints + the v1 identity-spine workflow.

Run (Command Prompt, from backend\, with Postgres up and the server running):
    uvicorn app.main:app --reload
    python test_person_a_endpoints.py

It exercises the full intended v1 flow on a single shared org:
  signup (Alice, Bob join the one org)
  -> Alice creates a folder + document  (creator-owns: Alice becomes owner)
  -> suggestions: list/create/accept       (owner can resolve)
  -> comments: create/list
  -> versions: submit-for-approval -> recommendations + responses
  -> audit: read history
  -> ownership: Alice hands the document to Bob, is demoted to editor
  -> after handover: Bob (owner) can resolve; Alice (editor) cannot
Plus edge cases: 401 / 403 / 404 / 422 / 405 and self-transfer 400.
"""

import sys
import uuid
import httpx

BASE = "http://127.0.0.1:8000/api"
RANDOM_ID = str(uuid.uuid4())
_failures = []


def check(name, ok, extra=""):
    print(f"  [{'OK ' if ok else 'XX '}] {name}" + (f"  -> {extra}" if extra else ""))
    if not ok:
        _failures.append(name)


def signup(client, label):
    email = f"{label}_{uuid.uuid4().hex[:8]}@test.com"
    r = client.post("/auth/signup", json={"email": email, "password": "secret123", "display_name": label})
    if r.status_code != 201:
        print(f"FATAL: signup failed ({r.status_code}): {r.text}")
        sys.exit(1)
    body = r.json()
    return body["user"]["id"], body["token"], body["refresh_token"]


def main():
    with httpx.Client(base_url=BASE, timeout=20.0) as client:
        alice_id, alice_tok, alice_refresh = signup(client, "alice")
        bob_id, bob_tok, _ = signup(client, "bob")
        A = {"Authorization": f"Bearer {alice_tok}"}
        B = {"Authorization": f"Bearer {bob_tok}"}
        print(f"[setup] alice={alice_id} bob={bob_id} (same org)")

        # ---- Auth refresh / logout (real refresh-token store) -------------
        print("\n[Auth]")
        r = client.post("/auth/refresh", json={"refresh_token": alice_refresh})
        check("refresh -> 200 + token", r.status_code == 200 and bool(r.json().get("token")), str(r.status_code))
        rotated = r.json().get("refresh_token") if r.status_code == 200 else None
        # rotation: the original refresh token is now revoked
        r = client.post("/auth/refresh", json={"refresh_token": alice_refresh})
        check("reusing rotated token -> 401", r.status_code == 401, str(r.status_code))
        r = client.post("/auth/refresh", json={"refresh_token": "garbage"})
        check("refresh bad token -> 401", r.status_code == 401, str(r.status_code))
        # logout revokes the (rotated) live token
        r = client.post("/auth/logout", json={"refresh_token": rotated or alice_refresh})
        check("logout -> 200", r.status_code == 200, str(r.status_code))

        # ---- Alice creates a folder + document (becomes owner) ------------
        print("\n[Setup doc]")
        r = client.post("/folders", json={"name": "Team Folder", "parent_folder_id": None}, headers=A)
        check("create folder -> 201", r.status_code == 201, str(r.status_code))
        folder_id = r.json()["id"]
        r = client.post("/documents", json={"folder_id": folder_id, "title": "Spec"}, headers=A)
        check("create document -> 201", r.status_code == 201, str(r.status_code))
        doc_id = r.json()["id"]

        # ---- Suggestions (Alice = owner) ----------------------------------
        print("\n[Suggestions]")
        r = client.get(f"/documents/{doc_id}/suggestions", headers=A)
        check("list suggestions -> 200 empty", r.status_code == 200 and r.json()["suggestions"] == [], str(r.status_code))
        r = client.post(f"/documents/{doc_id}/suggestions",
                        json={"type": "insert", "anchor": {"p": 1}, "origin": "human"}, headers=A)
        check("owner create suggestion -> 201", r.status_code == 201, str(r.status_code))
        sid = r.json().get("id") if r.status_code == 201 else None
        r = client.get(f"/documents/{doc_id}/suggestions", headers=A)
        check("list suggestions -> 1 item", r.status_code == 200 and len(r.json()["suggestions"]) == 1, str(r.status_code))
        if sid:
            r = client.post(f"/suggestions/{sid}/accept", json={"reason": "lgtm"}, headers=A)
            check("owner accept suggestion -> 200", r.status_code == 200, str(r.status_code))
        # edge cases
        r = client.get(f"/documents/{doc_id}/suggestions")
        check("suggestions no token -> 401", r.status_code == 401, str(r.status_code))
        r = client.get(f"/documents/{RANDOM_ID}/suggestions", headers=A)
        check("suggestions missing doc -> 404", r.status_code == 404, str(r.status_code))
        r = client.post(f"/documents/{doc_id}/suggestions", json={"type": "bogus", "anchor": {}}, headers=A)
        check("suggestion bad type -> 422", r.status_code == 422, str(r.status_code))
        r = client.post(f"/documents/{doc_id}/suggestions",
                        json={"type": "insert", "anchor": {}}, headers=B)
        check("bob (no role) create suggestion -> 403", r.status_code == 403, str(r.status_code))

        # ---- Comments -----------------------------------------------------
        print("\n[Comments]")
        r = client.post(f"/documents/{doc_id}/comments", json={"body": "first comment"}, headers=A)
        check("owner create comment -> 201", r.status_code == 201, str(r.status_code))
        r = client.get(f"/documents/{doc_id}/comments", headers=A)
        check("list comments -> 1 item", r.status_code == 200 and len(r.json()["comments"]) == 1, str(r.status_code))
        r = client.post(f"/documents/{doc_id}/comments", json={}, headers=A)
        check("comment no body -> 422", r.status_code == 422, str(r.status_code))

        # ---- Versions -> Recommendations + responses ----------------------
        print("\n[Recommendations]")
        r = client.post(f"/documents/{doc_id}/submit-for-approval", json={}, headers=A)
        check("submit-for-approval -> 200", r.status_code == 200, str(r.status_code))
        vid = r.json().get("version_id") if r.status_code == 200 else None
        rid = None
        if vid:
            r = client.post(f"/versions/{vid}/recommendations",
                            json={"body": "tighten intro", "anchor": {"p": 2}}, headers=A)
            check("create recommendation -> 201", r.status_code == 201, str(r.status_code))
            rid = r.json().get("id") if r.status_code == 201 else None
            r = client.get(f"/versions/{vid}/recommendations", headers=A)
            check("list recommendations -> >=1", r.status_code == 200 and len(r.json()["recommendations"]) >= 1, str(r.status_code))
        if rid:
            r = client.patch(f"/recommendations/{rid}", json={"status": "addressed"}, headers=A)
            check("patch recommendation -> 200", r.status_code == 200 and r.json()["status"] == "addressed", str(r.status_code))
            r = client.post(f"/recommendations/{rid}/responses", json={"body": "done"}, headers=A)
            check("post response -> 201", r.status_code == 201, str(r.status_code))
            r = client.get(f"/recommendations/{rid}/responses", headers=A)
            check("list responses -> 1", r.status_code == 200 and len(r.json()["responses"]) == 1, str(r.status_code))
            r = client.request("DELETE", f"/recommendations/{rid}/responses", headers=A)
            check("DELETE responses -> 405 (append-only)", r.status_code == 405, str(r.status_code))
        # validation + 404 edges
        r = client.patch(f"/recommendations/{RANDOM_ID}", json={"status": "bogus"}, headers=A)
        check("patch recommendation bad status -> 422", r.status_code == 422, str(r.status_code))
        r = client.patch(f"/recommendations/{RANDOM_ID}", json={"status": "open"}, headers=A)
        check("patch missing recommendation -> 404", r.status_code == 404, str(r.status_code))

        # ---- Audit (owner can_view_history) -------------------------------
        print("\n[Audit]")
        r = client.get(f"/documents/{doc_id}/audit", headers=A)
        check("owner read audit -> 200 (list)", r.status_code == 200 and isinstance(r.json()["entries"], list), str(r.status_code))
        r = client.get(f"/documents/{doc_id}/audit", headers=B)
        check("bob (no role) read audit -> 403", r.status_code == 403, str(r.status_code))

        # ---- Ownership handover -------------------------------------------
        print("\n[Ownership handover]")
        r = client.post(f"/documents/{doc_id}/transfer-ownership",
                        json={"to_user_id": alice_id}, headers=A)
        check("transfer to self -> 400", r.status_code == 400, str(r.status_code))
        r = client.post(f"/documents/{doc_id}/transfer-ownership",
                        json={"to_user_id": bob_id, "demote_to": "emperor"}, headers=A)
        check("transfer bad demote_to -> 422", r.status_code == 422, str(r.status_code))
        r = client.post(f"/documents/{doc_id}/transfer-ownership",
                        json={"to_user_id": bob_id, "demote_to": "editor"}, headers=A)
        check("Alice transfers ownership to Bob -> 200", r.status_code == 200, str(r.status_code))

        # After handover: Bob is owner, Alice is editor on this doc.
        r = client.post(f"/documents/{doc_id}/suggestions", json={"type": "insert", "anchor": {"p": 3}}, headers=B)
        check("Bob (new owner) create suggestion -> 201", r.status_code == 201, str(r.status_code))
        new_sid = r.json().get("id") if r.status_code == 201 else None
        r = client.post(f"/documents/{doc_id}/suggestions", json={"type": "insert", "anchor": {"p": 4}}, headers=A)
        check("Alice (now editor) create suggestion -> 201", r.status_code == 201, str(r.status_code))
        alice_sid = r.json().get("id") if r.status_code == 201 else None
        if alice_sid:
            r = client.post(f"/suggestions/{alice_sid}/accept", json={}, headers=A)
            check("Alice (editor) accept -> 403 (no can_resolve_suggestion)", r.status_code == 403, str(r.status_code))
        if new_sid:
            r = client.post(f"/suggestions/{new_sid}/accept", json={}, headers=B)
            check("Bob (owner) accept -> 200", r.status_code == 200, str(r.status_code))

    print("\n" + "=" * 56)
    if _failures:
        print(f"FAILED ({len(_failures)}): " + ", ".join(_failures))
        print("=" * 56)
        sys.exit(1)
    print("ALL v1 WORKFLOW + EDGE-CASE CHECKS PASSED")
    print("=" * 56)


if __name__ == "__main__":
    main()
