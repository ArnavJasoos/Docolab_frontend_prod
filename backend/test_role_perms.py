"""
Tests the v3 role/permission model:
  - the role set is exactly {owner, approver, editor, viewer} (no 'suggester')
  - editor   CAN now submit-for-approval (new) and edit; CANNOT give final approval
  - approver CAN now edit directly (new), submit, and approve
  - viewer   still cannot edit or submit
  - ownership demote_to 'suggester' is rejected (422)
  - end-to-end: editor submits -> approver approves -> version approved

Run with the server up:  python test_role_perms.py
"""
import sys
import uuid
import httpx

BASE = "http://127.0.0.1:8000/api"
_fail = []


def check(name, ok, extra=""):
    print(f"  [{'OK ' if ok else 'XX '}] {name}" + (f"  -> {extra}" if extra else ""))
    if not ok:
        _fail.append(name)


def auth(tok):
    return {"Authorization": f"Bearer {tok}"}


def signup(c, label):
    j = c.post("/auth/signup", json={"email": f"{label}_{uuid.uuid4().hex[:8]}@t.com",
                                     "password": "secret123", "display_name": label}).json()
    return j["user"]["id"], auth(j["token"])


def main():
    with httpx.Client(base_url=BASE, timeout=25) as c:
        r = c.post("/auth/login", json={"email": "admin@acme.com", "password": "adminsecret"})
        if r.status_code != 200:
            print("FATAL admin login", r.status_code, r.text); sys.exit(1)
        AH = auth(r.json()["token"])

        # --- role set ---
        print("[role set]")
        roles = {x["name"]: x["id"] for x in c.get("/roles", headers=AH).json()["roles"]}
        check("roles are exactly {owner, approver, editor, viewer}",
              set(roles) == {"owner", "approver", "editor", "viewer"}, sorted(roles))
        check("'suggester' role no longer exists", "suggester" not in roles)

        # --- set up a doc + members (document-scoped roles) ---
        fid = c.post("/folders", json={"name": "Perms", "parent_folder_id": None}, headers=AH).json()["id"]
        did = c.post("/documents", json={"folder_id": fid, "title": "Doc"}, headers=AH).json()["id"]
        ed_id, ED = signup(c, "ed"); ap_id, AP = signup(c, "ap"); vw_id, VW = signup(c, "vw")
        for uid_, rid in [(ed_id, roles["editor"]), (ap_id, roles["approver"]), (vw_id, roles["viewer"])]:
            r = c.post("/assignments", json={"user_id": uid_, "role_id": rid,
                                             "scope_type": "document", "scope_id": did}, headers=AH)
            assert r.status_code == 201, f"assign failed: {r.status_code} {r.text}"

        # --- editing rights ---
        print("\n[edit rights]")
        check("editor can edit (PATCH) -> 200",
              c.patch(f"/documents/{did}", json={"title": "by editor"}, headers=ED).status_code == 200)
        check("approver can edit (PATCH) -> 200 (NEW)",
              c.patch(f"/documents/{did}", json={"title": "by approver"}, headers=AP).status_code == 200)
        check("viewer cannot edit (PATCH) -> 403",
              c.patch(f"/documents/{did}", json={"title": "by viewer"}, headers=VW).status_code == 403)

        # --- submit rights ---
        print("\n[submit rights]")
        r = c.post(f"/documents/{did}/submit-for-approval", json={}, headers=ED)
        check("editor can submit-for-approval -> 200 (NEW)", r.status_code == 200, r.status_code)
        vid = r.json().get("version_id") if r.status_code == 200 else None
        # a second working doc to check viewer submit is blocked
        did2 = c.post("/documents", json={"folder_id": fid, "title": "D2"}, headers=AH).json()["id"]
        c.post("/assignments", json={"user_id": vw_id, "role_id": roles["viewer"],
                                     "scope_type": "document", "scope_id": did2}, headers=AH)
        check("viewer cannot submit -> 403",
              c.post(f"/documents/{did2}/submit-for-approval", json={}, headers=VW).status_code == 403)

        # --- approval rights (single owner gate: needs can_give_final_approval) ---
        print("\n[approval rights]")
        check("editor cannot give final approval -> 403",
              c.post(f"/versions/{vid}/approve", json={}, headers=ED).status_code == 403)
        r = c.post(f"/versions/{vid}/approve", json={}, headers=AP)
        check("approver can approve -> 200", r.status_code == 200, r.status_code)
        check("version is approved after approver sign-off",
              c.get(f"/versions/{vid}", headers=AP).json().get("kind") == "approved")

        # --- suggester is gone from the demote vocabulary ---
        print("\n[suggester removed everywhere]")
        r = c.post(f"/documents/{did}/transfer-ownership",
                   json={"to_user_id": ed_id, "demote_to": "suggester"}, headers=AH)
        check("ownership demote_to='suggester' -> 422 (no longer a valid role)", r.status_code == 422, r.status_code)

    print("\n" + "=" * 56)
    if _fail:
        print("FAILED:", ", ".join(_fail)); print("=" * 56); sys.exit(1)
    print("ALL ROLE / PERMISSION CHECKS PASSED"); print("=" * 56)


if __name__ == "__main__":
    main()
