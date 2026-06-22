import httpx, asyncio, random, sys

BASE = "http://localhost:8000/api"
PASS = []
FAIL = []

def check(label, code, expected, detail=""):
    ok = (
        (isinstance(expected, int) and code == expected) or
        (expected == "2xx" and 200 <= code < 300) or
        (expected == "401or403" and code in (401, 403))
    )
    tag = "PASS" if ok else "FAIL"
    print(f"[{tag}] HTTP {code}  {label}  =>  {detail}")
    (PASS if ok else FAIL).append(label)

async def run():
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:

        # --- AUTH ---
        r = await c.post(f"{BASE}/auth/login", json={"email": "admin@acme.com", "password": "adminsecret"})
        tok = r.json()["token"]
        user_id = r.json()["user"]["id"]
        H = {"Authorization": f"Bearer {tok}"}
        check("POST /auth/login", r.status_code, 200, r.json()["user"]["email"])

        r = await c.post(f"{BASE}/auth/login", json={"email": "admin@acme.com", "password": "WRONG"})
        check("POST /auth/login (wrong pw)", r.status_code, 401, "rejected")

        r = await c.get(f"{BASE}/auth/me")
        check("GET /auth/me (no token)", r.status_code, "401or403", "correctly blocked")

        r = await c.get(f"{BASE}/auth/me", headers=H)
        check("GET /auth/me", r.status_code, 200, r.json().get("email"))

        # --- USERS ---
        r = await c.get(f"{BASE}/users", headers=H)
        users = r.json().get("users", r.json())
        check("GET /users (list)", r.status_code, 200, f"{len(users)} users")

        r = await c.get(f"{BASE}/users/{user_id}", headers=H)
        check("GET /users/{id}", r.status_code, 200, r.json().get("display_name"))

        # --- ROLES ---
        r = await c.get(f"{BASE}/roles", headers=H)
        roles = r.json().get("roles", r.json())
        names = [x["name"] for x in roles]
        check("GET /roles", r.status_code, 200, str(names))

        # --- FOLDERS ---
        r = await c.get(f"{BASE}/folders", headers=H)
        folders = r.json().get("folders", r.json())
        root_id = folders[0]["id"] if folders else None
        check("GET /folders", r.status_code, 200, f"{len(folders)} folders, root_id={root_id}")

        r = await c.post(f"{BASE}/folders", headers=H, json={"name": "IntegTest Folder", "parent_id": root_id})
        fid = r.json().get("id") or (r.json().get("folder") or {}).get("id")
        check("POST /folders (create)", r.status_code, 201, f"name={r.json().get('name')} id={fid}")

        # --- DOCUMENTS ---
        r = await c.post(f"{BASE}/documents", headers=H, json={"title": "IntegTest Doc", "folder_id": fid, "content": "Hello integration!"})
        did = r.json().get("id")
        check("POST /documents (create)", r.status_code, 201, f"title={r.json().get('title')} id={did}")

        r = await c.get(f"{BASE}/documents/{did}", headers=H)
        check("GET /documents/{id}", r.status_code, 200, f"title={r.json().get('title')}")

        r = await c.patch(f"{BASE}/documents/{did}", headers=H, json={"title": "Updated Title"})
        check("PATCH /documents/{id}", r.status_code, 200, f"title={r.json().get('title')}")

        # DB PERSISTENCE: re-fetch and verify title survived the PATCH
        r = await c.get(f"{BASE}/documents/{did}", headers=H)
        persisted = r.json().get("title")
        ok_p = persisted == "Updated Title"
        tag = "PASS" if ok_p else "FAIL"
        print(f"[{tag}] HTTP {r.status_code}  DB persistence (title after PATCH)  =>  '{persisted}'")
        (PASS if ok_p else FAIL).append("DB persistence")

        r = await c.get(f"{BASE}/documents?folder_id={fid}", headers=H)
        docs = r.json().get("documents", r.json())
        check("GET /documents?folder_id (list)", r.status_code, 200, f"{len(docs)} docs in folder")

        # --- VERSIONS ---
        r = await c.get(f"{BASE}/documents/{did}/versions", headers=H)
        versions = r.json().get("versions", r.json())
        check("GET /documents/{id}/versions", r.status_code, 200, f"{len(versions)} versions")

        # --- AUDIT ---
        r = await c.get(f"{BASE}/documents/{did}/audit", headers=H)
        audit = r.json().get("entries", r.json().get("audit", r.json()))
        check("GET /documents/{id}/audit", r.status_code, 200, f"{len(audit)} audit entries")

        # --- NOTIFICATIONS ---
        r = await c.get(f"{BASE}/notifications", headers=H)
        notifs = r.json().get("notifications", r.json())
        check("GET /notifications", r.status_code, 200, f"{len(notifs)} notifications")

        # --- SIGNUP (new user -> DB write) ---
        rand = random.randint(10000, 99999)
        r = await c.post(f"{BASE}/auth/signup", json={"email": f"testuser{rand}@test.com", "password": "testpass123", "display_name": f"Test User {rand}"})
        new_tok = r.json().get("token", "")
        check("POST /auth/signup (new user)", r.status_code, 201, f"token={new_tok[:20]}...")

        if new_tok:
            r = await c.post(f"{BASE}/auth/login", json={"email": f"testuser{rand}@test.com", "password": "testpass123"})
            check("POST /auth/login (new user round-trip)", r.status_code, 200, "new user can login after signup")

        # Verify new user appears in DB (list users)
        r = await c.get(f"{BASE}/users", headers=H)
        users_after = r.json().get("users", r.json())
        found_new = any(f"testuser{rand}@test.com" == u.get("email") for u in users_after)
        ok_u = found_new
        tag = "PASS" if ok_u else "FAIL"
        print(f"[{tag}] HTTP {r.status_code}  DB: new user visible in /users list  =>  {'found' if found_new else 'NOT FOUND'}")
        (PASS if ok_u else FAIL).append("DB: new user in list")

        # --- CLEANUP ---
        r = await c.delete(f"{BASE}/documents/{did}", headers=H)
        check("DELETE /documents/{id}", r.status_code, 204, "deleted")

        # Confirm deleted document is gone
        r = await c.get(f"{BASE}/documents/{did}", headers=H)
        ok_d = r.status_code in (404, 403)
        tag = "PASS" if ok_d else "FAIL"
        print(f"[{tag}] HTTP {r.status_code}  GET deleted doc  =>  {'correctly 404' if ok_d else 'BUG: doc still accessible'}")
        (PASS if ok_d else FAIL).append("GET deleted doc = 404")

        r = await c.delete(f"{BASE}/folders/{fid}", headers=H)
        check("DELETE /folders/{id}", r.status_code, 204, "deleted")

    print(f"\n{'='*44}")
    print(f"TOTAL: {len(PASS)} PASS  |  {len(FAIL)} FAIL")
    if FAIL:
        print(f"\nFAILED:")
        for f in FAIL:
            print(f"  - {f}")
    print(f"{'='*44}")

asyncio.run(run())
