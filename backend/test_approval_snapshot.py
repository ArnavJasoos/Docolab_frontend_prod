"""
Tests the approval-policy SNAPSHOT-AT-SUBMIT nuance: the in-flight approval
chain is resolved against the policy captured on the submission Version, NOT
the document's live approval_policy_id. Editing/detaching the policy mid-review
therefore cannot corrupt an ongoing approval.

  Direction B (policy at submit, detached after) -> chain still follows snapshot:
    attach 1-step policy -> submit (snapshots it) -> detach from doc ->
    approval-status still reports the chain (single_gate=false) -> owner approves
    the snapshotted step -> baseline advances.

  Direction A (no policy at submit, attached after) -> single gate still applies:
    submit with no policy (snapshots NULL) -> attach a 2-step policy ->
    approval-status reports single_gate=true (NULL snapshot) -> one owner approval
    completes it (the later-attached 2-step policy is ignored for this submission).

Run with the server up:  python test_approval_snapshot.py
"""
import sys
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
            print("FATAL admin login", r.status_code, r.text); sys.exit(1)
        AH = {"Authorization": f"Bearer {r.json()['token']}"}
        owner_rid = {x["name"]: x["id"] for x in c.get("/roles", headers=AH).json()["roles"]}["owner"]
        fid = c.post("/folders", json={"name": "Snap", "parent_folder_id": None}, headers=AH).json()["id"]

        print("[Direction B: policy snapshotted at submit survives a detach]")
        pol1 = c.post("/approval-policies", json={"name": "One", "steps": [
            {"step_no": 1, "required_role_id": owner_rid, "min_approvals": 1}]}, headers=AH).json()["id"]
        d1 = c.post("/documents", json={"folder_id": fid, "title": "B"}, headers=AH).json()["id"]
        c.patch(f"/documents/{d1}/approval-policy", json={"policy_id": pol1}, headers=AH)
        v1 = c.post(f"/documents/{d1}/submit-for-approval", json={}, headers=AH).json()["version_id"]
        # detach the policy from the live document AFTER submit
        c.patch(f"/documents/{d1}/approval-policy", json={"policy_id": None}, headers=AH)
        js = c.get(f"/versions/{v1}/approval-status", headers=AH).json()
        check("status reads snapshot (chain), not live (single gate)",
              js.get("single_gate") is False and js.get("next_step") == 1, js)
        r = c.post(f"/versions/{v1}/approve", json={}, headers=AH)
        check("owner approves snapshotted step -> 200 complete",
              r.status_code == 200 and "complete" in r.json()["message"].lower(), r.json().get("message"))
        check("version is approved", c.get(f"/versions/{v1}", headers=AH).json().get("kind") == "approved")

        print("\n[Direction A: NULL snapshot at submit ignores a later-attached policy]")
        d2 = c.post("/documents", json={"folder_id": fid, "title": "A"}, headers=AH).json()["id"]
        v2 = c.post(f"/documents/{d2}/submit-for-approval", json={}, headers=AH).json()["version_id"]
        # attach a 2-step policy AFTER submit; the submission snapshotted NULL
        pol2 = c.post("/approval-policies", json={"name": "Two", "steps": [
            {"step_no": 1, "required_role_id": owner_rid, "min_approvals": 1},
            {"step_no": 2, "required_role_id": owner_rid, "min_approvals": 1}]}, headers=AH).json()["id"]
        c.patch(f"/documents/{d2}/approval-policy", json={"policy_id": pol2}, headers=AH)
        js = c.get(f"/versions/{v2}/approval-status", headers=AH).json()
        check("status reports single_gate (NULL snapshot), not the new 2-step",
              js.get("single_gate") is True, js)
        r = c.post(f"/versions/{v2}/approve", json={}, headers=AH)
        check("single owner approval completes it in one step -> 200", r.status_code == 200, r.status_code)
        check("version approved (2-step policy ignored for this submission)",
              c.get(f"/versions/{v2}", headers=AH).json().get("kind") == "approved")

    print("\n" + "=" * 56)
    if _fail:
        print("FAILED:", ", ".join(_fail)); print("=" * 56); sys.exit(1)
    print("ALL APPROVAL-SNAPSHOT CHECKS PASSED"); print("=" * 56)


if __name__ == "__main__":
    main()
