"""
Tests personal bookmarks (document_stars) + the unified trash/delete model:

  STARS (personal, per-user; no edit rights needed):
    - a VIEWER (read-only) can star a doc they can't edit
    - stars are personal: user A starring does NOT star it for user B
    - ?starred=true lists only the caller's starred docs
    - a user with NO access to a doc cannot star it (403)
    - star/unstar are idempotent

  TRASH vs DELETE:
    - PATCH {trashed:true} = reversible recycle bin; hidden from default list,
      shown by ?trashed=true; PATCH {trashed:false} restores it
    - DELETE = permanent (status=deleted): 404 afterwards, hidden everywhere
    - cannot trash OR delete a doc that is pending approval (409)

Run with the server up:  python test_stars_trash.py
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


def main():
    with httpx.Client(base_url=BASE, timeout=25) as c:
        # admin (org-admin, owner) sets up a folder + doc and a viewer member
        r = c.post("/auth/login", json={"email": "admin@acme.com", "password": "adminsecret"})
        if r.status_code != 200:
            print("FATAL admin login", r.status_code, r.text); sys.exit(1)
        AH = auth(r.json()["token"])

        viewer = c.post("/auth/signup", json={"email": f"vw_{uuid.uuid4().hex[:8]}@t.com",
                                              "password": "secret123", "display_name": "Viewer"}).json()
        VH = auth(viewer["token"]); viewer_id = viewer["user"]["id"]
        stranger = c.post("/auth/signup", json={"email": f"st_{uuid.uuid4().hex[:8]}@t.com",
                                                "password": "secret123", "display_name": "Stranger"}).json()
        SH = auth(stranger["token"])

        fid = c.post("/folders", json={"name": "StarTrash", "parent_folder_id": None}, headers=AH).json()["id"]
        did = c.post("/documents", json={"folder_id": fid, "title": "Doc"}, headers=AH).json()["id"]

        # grant the viewer a read-only (viewer) role on the folder
        roles = {x["name"]: x["id"] for x in c.get("/roles", headers=AH).json()["roles"]}
        c.post("/assignments", json={"user_id": viewer_id, "role_id": roles["viewer"],
                                     "scope_type": "folder", "scope_id": fid}, headers=AH)

        print("[stars: personal + no edit rights needed]")
        # viewer cannot edit, but CAN star
        r = c.patch(f"/documents/{did}", json={"title": "nope"}, headers=VH)
        check("viewer cannot edit doc -> 403", r.status_code == 403, r.status_code)
        r = c.put(f"/documents/{did}/star", headers=VH)
        check("viewer can star a read-only doc -> 200 starred", r.status_code == 200 and r.json()["starred"] is True, r.status_code)
        r = c.put(f"/documents/{did}/star", headers=VH)
        check("star is idempotent -> 200", r.status_code == 200, r.status_code)

        # personal: viewer sees it starred, admin does not
        check("GET doc as viewer -> starred true",
              c.get(f"/documents/{did}", headers=VH).json()["starred"] is True)
        check("GET doc as admin -> starred false (personal!)",
              c.get(f"/documents/{did}", headers=AH).json()["starred"] is False)

        # ?starred=true is per-user
        vlist = c.get("/documents", params={"starred": "true"}, headers=VH).json()["documents"]
        check("viewer ?starred=true includes the doc", any(d["id"] == did for d in vlist), len(vlist))
        alist = c.get("/documents", params={"starred": "true"}, headers=AH).json()["documents"]
        check("admin ?starred=true excludes it", all(d["id"] != did for d in alist), len(alist))

        # stranger (no role on the doc) cannot star it
        r = c.put(f"/documents/{did}/star", headers=SH)
        check("stranger with no access -> star 403", r.status_code == 403, r.status_code)

        # unstar
        r = c.delete(f"/documents/{did}/star", headers=VH)
        check("viewer unstar -> 200 starred false", r.status_code == 200 and r.json()["starred"] is False, r.status_code)
        check("after unstar, viewer ?starred=true is empty of doc",
              all(d["id"] != did for d in c.get("/documents", params={"starred": "true"}, headers=VH).json()["documents"]))
        r = c.delete(f"/documents/{did}/star", headers=VH)
        check("unstar idempotent -> 200", r.status_code == 200, r.status_code)

        print("\n[trash = reversible recycle bin]")
        r = c.patch(f"/documents/{did}", json={"trashed": True}, headers=AH)
        check("trash -> 200", r.status_code == 200, r.status_code)
        deflist = [d["id"] for d in c.get("/documents", params={"folder_id": fid}, headers=AH).json()["documents"]]
        check("default list hides trashed", did not in deflist)
        binlist = [d["id"] for d in c.get("/documents", params={"folder_id": fid, "trashed": "true"}, headers=AH).json()["documents"]]
        check("?trashed=true shows the recycle bin", did in binlist)
        r = c.patch(f"/documents/{did}", json={"trashed": False}, headers=AH)
        check("restore -> 200", r.status_code == 200, r.status_code)
        deflist = [d["id"] for d in c.get("/documents", params={"folder_id": fid}, headers=AH).json()["documents"]]
        check("restored doc reappears in default list", did in deflist)

        print("\n[permanent delete]")
        r = c.delete(f"/documents/{did}", headers=AH)
        check("DELETE -> 204", r.status_code == 204, r.status_code)
        check("GET after delete -> 404", c.get(f"/documents/{did}", headers=AH).status_code == 404)
        alllist = [d["id"] for d in c.get("/documents", params={"folder_id": fid, "trashed": "true"}, headers=AH).json()["documents"]]
        check("deleted doc hidden even from recycle bin", did not in alllist)

        print("\n[guards: cannot trash/delete a doc pending approval]")
        did2 = c.post("/documents", json={"folder_id": fid, "title": "Pending"}, headers=AH).json()["id"]
        c.post(f"/documents/{did2}/submit-for-approval", json={}, headers=AH)
        r = c.patch(f"/documents/{did2}", json={"trashed": True}, headers=AH)
        check("trash pending-approval doc -> 409", r.status_code == 409, r.status_code)
        r = c.delete(f"/documents/{did2}", headers=AH)
        check("delete pending-approval doc -> 409", r.status_code == 409, r.status_code)

    print("\n" + "=" * 56)
    if _fail:
        print("FAILED:", ", ".join(_fail)); print("=" * 56); sys.exit(1)
    print("ALL STARS / TRASH / DELETE CHECKS PASSED"); print("=" * 56)


if __name__ == "__main__":
    main()
