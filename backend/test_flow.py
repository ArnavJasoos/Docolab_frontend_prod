import httpx
import sys
import uuid

BASE_URL = "http://127.0.0.1:8000/api"


def run_demo():
    print("--- Auth Spine Verification (single-org v1) ---")

    with httpx.Client() as client:
        # Unique emails so the demo is re-runnable against a persistent DB.
        ana_email = f"ana_{uuid.uuid4().hex[:8]}@acme.com"
        bob_email = f"bob_{uuid.uuid4().hex[:8]}@acme.com"

        # 1. Sign up Ana (joins the single shared org)
        print("\n[Step 1] Creating Ana...")
        res_ana = client.post(f"{BASE_URL}/auth/signup", json={
            "email": ana_email, "password": "hunter2", "display_name": "Ana"})
        if res_ana.status_code != 201:
            print("Failed to signup Ana:", res_ana.text)
            sys.exit(1)
        ana_token = res_ana.json()["token"]
        ana_id = res_ana.json()["user"]["id"]
        print(f"-> Ana created: {ana_id}")

        # 2. Sign up Bob
        print("\n[Step 2] Creating Bob...")
        res_bob = client.post(f"{BASE_URL}/auth/signup", json={
            "email": bob_email, "password": "password123", "display_name": "Bob"})
        bob_token = res_bob.json()["token"]
        bob_id = res_bob.json()["user"]["id"]
        print(f"-> Bob created: {bob_id}")

        # 3. Login as the seeded admin (owner of the org's root workspace)
        print("\n[Step 3] Logging in as Admin...")
        res_login = client.post(f"{BASE_URL}/auth/login", json={
            "email": "admin@acme.com", "password": "adminsecret"})
        if res_login.status_code != 200:
            print("Failed to login admin. Is DB seeded?", res_login.text)
            sys.exit(1)
        admin_token = res_login.json()["token"]
        headers_admin = {"Authorization": f"Bearer {admin_token}"}
        print("-> Logged in as Admin.")

        # Resolve role ids (UUIDs) by name.
        roles = {r["name"]: r["id"] for r in client.get(f"{BASE_URL}/roles", headers=headers_admin).json()["roles"]}

        # 4. Admin creates a folder (admin becomes its owner via creator-owns)
        print("\n[Step 4] Admin creates folder 'Engineering'...")
        folder_id = client.post(f"{BASE_URL}/folders",
            json={"name": "Engineering", "parent_folder_id": None}, headers=headers_admin).json()["id"]
        print(f"-> Folder: {folder_id}")

        # 5. Assign roles on the folder (admin has can_manage_members as owner)
        print("\n[Step 5] Assigning folder roles...")
        r1 = client.post(f"{BASE_URL}/assignments", json={
            "user_id": ana_id, "role_id": roles["editor"],
            "scope_type": "folder", "scope_id": folder_id}, headers=headers_admin)
        print("-> Ana (editor) on Engineering:", r1.status_code)
        r2 = client.post(f"{BASE_URL}/assignments", json={
            "user_id": bob_id, "role_id": roles["viewer"],
            "scope_type": "folder", "scope_id": folder_id}, headers=headers_admin)
        print("-> Bob (viewer) on Engineering:", r2.status_code)

        # 6. Admin creates the document (so Ana/Bob exercise INHERITED folder
        #    roles; if Ana created it she'd own it via creator-owns).
        print("\n[Step 6] Admin creates document 'API Spec'...")
        doc_id = client.post(f"{BASE_URL}/documents",
            json={"folder_id": folder_id, "title": "API Spec"}, headers=headers_admin).json()["id"]
        print(f"-> Document: {doc_id}")

        # 7. List documents (as Ana)
        print("\n[Step 7] Listing documents...")
        headers_ana = {"Authorization": f"Bearer {ana_token}"}
        print("-> Docs:", client.get(f"{BASE_URL}/documents?folder_id={folder_id}", headers=headers_ana).json())

        # 8. Authorization walk (roles inherited from the folder)
        print("\n[Step 8] Authorization resolution...")
        print("-> Ana can_edit_direct (expect True/editor):",
              client.get(f"{BASE_URL}/documents/{doc_id}/authorize-check?permission=can_edit_direct", headers=headers_ana).json())
        print("-> Ana can_give_final_approval (expect False/editor):",
              client.get(f"{BASE_URL}/documents/{doc_id}/authorize-check?permission=can_give_final_approval", headers=headers_ana).json())
        headers_bob = {"Authorization": f"Bearer {bob_token}"}
        print("-> Bob can_edit_direct (expect False/viewer):",
              client.get(f"{BASE_URL}/documents/{doc_id}/authorize-check?permission=can_edit_direct", headers=headers_bob).json())

        print("\n--- Demo flow executed ---")


if __name__ == "__main__":
    run_demo()
