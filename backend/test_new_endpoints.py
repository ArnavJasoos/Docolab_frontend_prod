import httpx
import sys
import uuid

BASE_URL = "http://127.0.0.1:8000/api"


def run_full_test():
    print("=== Testing core endpoints (single-org v1) ===\n")

    with httpx.Client() as client:
        # Setup: 3 users with UNIQUE emails so the test is re-runnable against a
        # persistent DB. All three join the single shared org.
        print("[SETUP] Creating test users...")
        users = {}
        for name in ["Alice", "Bob", "Charlie"]:
            email = f"{name.lower()}_{uuid.uuid4().hex[:8]}@test.com"
            res = client.post(f"{BASE_URL}/auth/signup", json={
                "email": email,
                "password": "pass1234",
                "display_name": name,
            })
            if res.status_code != 201:
                print(f"FAIL creating {name}: {res.status_code} {res.text}")
                sys.exit(1)
            data = res.json()
            users[name.lower()] = {"id": data["user"]["id"], "token": data["token"], "email": email}
            print(f"  OK {name} created")

        alice_id = users["alice"]["id"]
        bob_id = users["bob"]["id"]
        charlie_id = users["charlie"]["id"]
        alice_headers = {"Authorization": f"Bearer {users['alice']['token']}"}

        # Role ids are UUIDs now — look them up by name instead of hardcoding.
        res = client.get(f"{BASE_URL}/roles", headers=alice_headers)
        assert res.status_code == 200, f"GET /roles -> {res.status_code}"
        role_map = {r["name"]: r["id"] for r in res.json()["roles"]}
        assert "editor" in role_map, f"editor role not seeded; got {list(role_map)}"
        editor_role_id = role_map["editor"]
        print(f"  OK roles resolved: {list(role_map)}")

        # 1. GET /users — all three created users are present (org may also
        #    contain the seeded admin + users from prior runs).
        print("\n[1] GET /users")
        res = client.get(f"{BASE_URL}/users", headers=alice_headers)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        ids = {u["id"] for u in res.json()["users"]}
        assert {alice_id, bob_id, charlie_id} <= ids, "created users missing from list"
        print("  OK all 3 users present")

        # 2. PATCH /users/:id
        print("\n[2] PATCH /users/:id")
        res = client.patch(f"{BASE_URL}/users/{alice_id}",
            json={"display_name": "Alice Updated", "avatar_color": "#FF5733"},
            headers=alice_headers)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        assert res.json()["display_name"] == "Alice Updated"
        print("  OK user profile updated")

        # 3. POST /folders (Alice becomes owner of each via creator-owns)
        print("\n[3] POST /folders")
        res = client.post(f"{BASE_URL}/folders",
            json={"name": "Projects", "parent_folder_id": None}, headers=alice_headers)
        assert res.status_code == 201
        root_folder_id = res.json()["id"]
        res = client.post(f"{BASE_URL}/folders",
            json={"name": "Q1 Planning", "parent_folder_id": root_folder_id}, headers=alice_headers)
        assert res.status_code == 201
        nested_folder_id = res.json()["id"]
        print("  OK root + nested folders created")

        # 4. GET /folders
        print("\n[4] GET /folders")
        res = client.get(f"{BASE_URL}/folders", headers=alice_headers)
        assert res.status_code == 200
        assert len(res.json()["folders"]) >= 2
        print("  OK folders listed")

        # 5. PATCH /folders/:id
        print("\n[5] PATCH /folders/:id")
        res = client.patch(f"{BASE_URL}/folders/{root_folder_id}",
            json={"name": "All Projects"}, headers=alice_headers)
        assert res.status_code == 200 and res.json()["name"] == "All Projects"
        print("  OK folder renamed")

        # 6. POST /documents
        print("\n[6] POST /documents")
        res = client.post(f"{BASE_URL}/documents",
            json={"folder_id": nested_folder_id, "title": "Q1 Roadmap"}, headers=alice_headers)
        assert res.status_code == 201
        doc1_id = res.json()["id"]
        res = client.post(f"{BASE_URL}/documents",
            json={"folder_id": nested_folder_id, "title": "Budget Plan"}, headers=alice_headers)
        assert res.status_code == 201
        doc2_id = res.json()["id"]
        print("  OK 2 documents created")

        # 7. GET /documents/:id
        print("\n[7] GET /documents/:id")
        res = client.get(f"{BASE_URL}/documents/{doc1_id}", headers=alice_headers)
        assert res.status_code == 200 and res.json()["title"] == "Q1 Roadmap"
        print("  OK document fetched")

        # 8. PATCH /documents/:id
        print("\n[8] PATCH /documents/:id")
        res = client.patch(f"{BASE_URL}/documents/{doc1_id}",
            json={"title": "Q1 Roadmap - Updated", "folder_id": nested_folder_id}, headers=alice_headers)
        assert res.status_code == 200 and res.json()["title"] == "Q1 Roadmap - Updated"
        print("  OK document updated")

        # 9. POST /assignments — Alice owns nested_folder (creator-owns) so she
        #    has can_manage_members; assign Bob as editor.
        print("\n[9] POST /assignments")
        res = client.post(f"{BASE_URL}/assignments",
            json={"user_id": bob_id, "role_id": editor_role_id,
                  "scope_type": "folder", "scope_id": nested_folder_id},
            headers=alice_headers)
        assert res.status_code == 201, f"Expected 201, got {res.status_code} {res.text}"
        assignment_id = res.json()["id"]
        print("  OK Bob assigned editor")

        # 10. GET /assignments — Bob's assignment is present
        print("\n[10] GET /assignments")
        res = client.get(f"{BASE_URL}/assignments?scope_type=folder&scope_id={nested_folder_id}",
            headers=alice_headers)
        assert res.status_code == 200
        assert any(a["user_id"] == bob_id for a in res.json()["assignments"]), "Bob assignment missing"
        print("  OK Bob's assignment listed")

        # 11. DELETE /assignments/:id — Bob's assignment is gone afterwards
        #     (Alice's owner assignment from creator-owns still remains).
        print("\n[11] DELETE /assignments/:id")
        res = client.delete(f"{BASE_URL}/assignments/{assignment_id}", headers=alice_headers)
        assert res.status_code == 204
        res = client.get(f"{BASE_URL}/assignments?scope_type=folder&scope_id={nested_folder_id}",
            headers=alice_headers)
        assert not any(a["user_id"] == bob_id for a in res.json()["assignments"]), "Bob assignment not revoked"
        print("  OK Bob's assignment revoked")

        # 12. DELETE /documents/:id (PERMANENT: status=deleted, gone for good)
        print("\n[12] DELETE /documents/:id")
        res = client.delete(f"{BASE_URL}/documents/{doc2_id}", headers=alice_headers)
        assert res.status_code == 204
        # Permanent delete is terminal: the doc is no longer retrievable (404).
        # (The reversible recycle bin is PATCH {"trashed": true}, not DELETE.)
        res = client.get(f"{BASE_URL}/documents/{doc2_id}", headers=alice_headers)
        assert res.status_code == 404, f"expected 404 after permanent delete, got {res.status_code}"
        print("  OK document permanently deleted (404)")

        # 13. DELETE /folders/:id (empty only)
        print("\n[13] DELETE /folders/:id")
        res = client.post(f"{BASE_URL}/folders",
            json={"name": "Empty Folder", "parent_folder_id": root_folder_id}, headers=alice_headers)
        empty_folder_id = res.json()["id"]
        res = client.delete(f"{BASE_URL}/folders/{empty_folder_id}", headers=alice_headers)
        assert res.status_code == 204
        # nested still has documents -> blocked
        res = client.delete(f"{BASE_URL}/folders/{nested_folder_id}", headers=alice_headers)
        assert res.status_code == 400
        print("  OK empty folder deleted; non-empty blocked")

        print("\n" + "=" * 50)
        print("ALL CORE ENDPOINT TESTS PASSED")
        print("=" * 50)


if __name__ == "__main__":
    run_full_test()
