"""
Tests for the governance + org-admin + audit-read completion:
  - org-admin gating (org-wide GET /audit, editing other users)
  - org-wide audit surfaces non-document rows (e.g. user_signup)
  - approval policy CRUD + attach + multi-step chain (approve step-by-step)
  - distinct-actor guard (same actor can't satisfy a min_approvals>=2 step twice)
  - last-owner delete guard on assignments

Uses the seeded admin (admin@acme.com / adminsecret) who is the org-admin.
Run with the server up:  python test_governance.py
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


def main():
    with httpx.Client(base_url=BASE, timeout=25) as c:
        r = c.post("/auth/login", json={"email": "admin@acme.com", "password": "adminsecret"})
        if r.status_code != 200:
            print("FATAL admin login:", r.status_code, r.text); sys.exit(1)
        AH = {"Authorization": f"Bearer {r.json()['token']}"}
        reg = c.post("/auth/signup", json={"email": f"reg_{uuid.uuid4().hex[:8]}@t.com",
                                           "password": "secret123", "display_name": "Reg"}).json()
        reg_id = reg["user"]["id"]; RH = {"Authorization": f"Bearer {reg['token']}"}

        # ---- org-admin gating ----
        print("\n[Org-admin gating + org-wide audit]")
        r = c.get("/audit", headers=RH); check("regular user GET /audit -> 403", r.status_code == 403, r.status_code)
        r = c.get("/audit", headers=AH); check("admin GET /audit -> 200", r.status_code == 200, r.status_code)
        actions = {e["action"] for e in r.json()["entries"]} if r.status_code == 200 else set()
        check("org audit surfaces non-document rows (user_signup)", "user_signup" in actions, sorted(actions)[:8])
        r = c.patch(f"/users/{reg_id}", json={"status": "disabled"}, headers=AH)
        check("admin disables a user -> 200", r.status_code == 200, r.status_code)
        c.patch(f"/users/{reg_id}", json={"status": "active"}, headers=AH)  # re-enable

        # ---- approval policy CRUD + multi-step chain ----
        print("\n[Approval policy + multi-step chain]")
        roles = {x["name"]: x["id"] for x in c.get("/roles", headers=AH).json()["roles"]}
        owner_rid = roles["owner"]
        r = c.post("/approval-policies",
                   json={"name": "p", "steps": [{"step_no": 1, "required_role_id": owner_rid}]}, headers=RH)
        check("regular user create policy -> 403", r.status_code == 403, r.status_code)
        r = c.post("/approval-policies", json={"name": "Two-step", "steps": [
            {"step_no": 1, "required_role_id": owner_rid, "min_approvals": 1},
            {"step_no": 2, "required_role_id": owner_rid, "min_approvals": 1}]}, headers=AH)
        check("admin create 2-step policy -> 201", r.status_code == 201, r.status_code)
        pol = r.json()["id"]
        fid = c.post("/folders", json={"name": "Gov", "parent_folder_id": None}, headers=AH).json()["id"]
        did = c.post("/documents", json={"folder_id": fid, "title": "Gov doc"}, headers=AH).json()["id"]
        r = c.patch(f"/documents/{did}/approval-policy", json={"policy_id": pol}, headers=AH)
        check("attach policy to doc -> 200", r.status_code == 200, r.status_code)
        vid = c.post(f"/documents/{did}/submit-for-approval", json={}, headers=AH).json()["version_id"]
        js = c.get(f"/versions/{vid}/approval-status", headers=AH).json()
        check("status: chain (not single_gate), next_step=1", js.get("single_gate") is False and js.get("next_step") == 1, js)
        r = c.post(f"/versions/{vid}/approve", json={}, headers=AH)
        check("approve step 1 -> 200 (remaining)", r.status_code == 200 and "remaining" in r.json()["message"].lower(), r.json().get("message"))
        js = c.get(f"/versions/{vid}/approval-status", headers=AH).json()
        check("status: next_step=2", js.get("next_step") == 2, js.get("next_step"))
        r = c.post(f"/versions/{vid}/approve", json={}, headers=AH)
        check("approve step 2 -> 200 (chain complete)", r.status_code == 200 and "complete" in r.json()["message"].lower(), r.json().get("message"))
        js = c.get(f"/versions/{vid}/approval-status", headers=AH).json()
        check("status: complete=true, next_step=null", js.get("complete") is True and js.get("next_step") is None, js)
        r = c.get(f"/versions/{vid}", headers=AH)
        check("version is approved", r.json().get("kind") == "approved", r.json().get("kind"))

        # ---- distinct-actor guard ----
        print("\n[Distinct-actor guard]")
        pol2 = c.post("/approval-policies", json={"name": "Need2", "steps": [
            {"step_no": 1, "required_role_id": owner_rid, "min_approvals": 2}]}, headers=AH).json()["id"]
        did2 = c.post("/documents", json={"folder_id": fid, "title": "D2"}, headers=AH).json()["id"]
        c.patch(f"/documents/{did2}/approval-policy", json={"policy_id": pol2}, headers=AH)
        vid2 = c.post(f"/documents/{did2}/submit-for-approval", json={}, headers=AH).json()["version_id"]
        r = c.post(f"/versions/{vid2}/approve", json={}, headers=AH)
        check("approve once (min2) -> 200 remaining", r.status_code == 200, r.status_code)
        r = c.post(f"/versions/{vid2}/approve", json={}, headers=AH)
        check("same actor approves same step again -> 409", r.status_code == 409, r.status_code)

        # ---- last-owner delete guard ----
        print("\n[Last-owner delete guard]")
        al = c.get(f"/assignments?scope_type=folder&scope_id={fid}", headers=AH).json()["assignments"]
        owners = [a for a in al if a["role_name"] == "owner"]
        check("folder has an owner assignment", len(owners) >= 1, len(owners))
        if owners:
            r = c.request("DELETE", f"/assignments/{owners[0]['id']}", headers=AH)
            check("delete the LAST owner -> 409", r.status_code == 409, r.status_code)

    print("\n" + "=" * 56)
    if _fail:
        print("FAILED:", ", ".join(_fail)); print("=" * 56); sys.exit(1)
    print("ALL GOVERNANCE / ORG-ADMIN / AUDIT CHECKS PASSED"); print("=" * 56)


if __name__ == "__main__":
    main()
