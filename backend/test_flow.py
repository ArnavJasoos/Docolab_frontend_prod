import httpx
import sys

BASE_URL = "http://127.0.0.1:8000/api"

def run_demo():
    print("--- Starting End-to-End Auth Spine Verification ---")
    
    with httpx.Client() as client:
        # 1. Sign up Ana
        print("\n[Step 1] Creating Ana...")
        res_ana = client.post(f"{BASE_URL}/auth/signup", json={
            "email": "ana@acme.com", "password": "hunter2", "display_name": "Ana"
        })
        if res_ana.status_code != 201:
            print("Failed to signup Ana:", res_ana.json())
            sys.exit(1)
        ana_data = res_ana.json()
        ana_token = ana_data["token"]
        ana_id = ana_data["user"]["id"]
        print(f"-> Ana Created. ID: {ana_id}")

        # 2. Sign up Bob
        print("\n[Step 2] Creating Bob...")
        res_bob = client.post(f"{BASE_URL}/auth/signup", json={
            "email": "bob@acme.com", "password": "password123", "display_name": "Bob"
        })
        bob_data = res_bob.json()
        bob_token = bob_data["token"]
        bob_id = bob_data["user"]["id"]
        print(f"-> Bob Created. ID: {bob_id}")

        # 3. Login as Admin
        print("\n[Step 3] Logging in as Admin...")
        res_login = client.post(f"{BASE_URL}/auth/login", json={
            "email": "admin@acme.com", "password": "adminsecret"
        })
        if res_login.status_code != 200:
            print("Failed to login admin. Is DB initialized?", res_login.json())
            sys.exit(1)
        admin_token = res_login.json()["token"]
        print("-> Logged in as Admin.")

        # 4. Create Folder "Engineering"
        print("\n[Step 4] Creating Folder 'Engineering'...")
        headers_admin = {"Authorization": f"Bearer {admin_token}"}
        res_folder = client.post(f"{BASE_URL}/folders", json={
            "name": "Engineering",
            "parent_folder_id": None
        }, headers=headers_admin)
        folder_id = res_folder.json()["id"]
        print(f"-> Folder Created. ID: {folder_id}")

        # Give admin permissions on engineering folder
        client.post(f"{BASE_URL}/assignments", json={
            "user_id": "user-admin-id",
            "role_id": "role-owner",
            "scope_type": "folder",
            "scope_id": folder_id
        }, headers=headers_admin)

        # 5. Assign Roles
        print("\n[Step 5] Writing Assignments...")
        res_ass_ana = client.post(f"{BASE_URL}/assignments", json={
            "user_id": ana_id,
            "role_id": "role-editor",
            "scope_type": "folder",
            "scope_id": folder_id
        }, headers=headers_admin)
        print("-> Assigned Ana (Editor) on Folder Engineering:", res_ass_ana.status_code)

        res_ass_bob = client.post(f"{BASE_URL}/assignments", json={
            "user_id": bob_id,
            "role_id": "role-viewer",
            "scope_type": "folder",
            "scope_id": folder_id
        }, headers=headers_admin)
        print("-> Assigned Bob (Viewer) on Folder Engineering:", res_ass_bob.status_code)

        # 6. Create Document
        print("\n[Step 6] Creating document as Ana...")
        headers_ana = {"Authorization": f"Bearer {ana_token}"}
        res_doc = client.post(f"{BASE_URL}/documents", json={
            "folder_id": folder_id,
            "title": "API Spec"
        }, headers=headers_ana)
        doc_id = res_doc.json()["id"]
        print(f"-> Document Created. ID: {doc_id}")

        # 7. List Documents
        print("\n[Step 7] Listing documents inside Engineering...")
        res_docs = client.get(f"{BASE_URL}/documents?folder_id={folder_id}", headers=headers_ana)
        print("-> Documents list:", res_docs.json())

        # 8. Authorization resolution checks
        print("\n[Step 8] Resolving Authorization Walk...")
        
        # Test Ana's can_edit_direct (expected True)
        check_ana = client.get(
            f"{BASE_URL}/documents/{doc_id}/authorize-check?permission=can_edit_direct",
            headers=headers_ana
        )
        print(f"-> Ana Check (can_edit_direct): {check_ana.json()}")

        # Test Ana's can_give_final_approval (expected False)
        check_ana_adm = client.get(
            f"{BASE_URL}/documents/{doc_id}/authorize-check?permission=can_give_final_approval",
            headers=headers_ana
        )
        print(f"-> Ana Check (can_give_final_approval): {check_ana_adm.json()}")

        # Test Bob's can_edit_direct (expected False)
        headers_bob = {"Authorization": f"Bearer {bob_token}"}
        check_bob = client.get(
            f"{BASE_URL}/documents/{doc_id}/authorize-check?permission=can_edit_direct",
            headers=headers_bob
        )
        print(f"-> Bob Check (can_edit_direct): {check_bob.json()}")

        print("\n--- Demo flow executed ---")

if __name__ == "__main__":
    run_demo()