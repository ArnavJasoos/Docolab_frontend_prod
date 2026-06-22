"""
Tests the REAL refresh-token store (replaces the JWT-only stubs):
  - signup / login return an access token AND a refresh token
  - /auth/refresh rotates: returns a new pair, old refresh token is revoked
  - reuse of a rotated token -> 401 AND revokes the whole token family
  - /auth/logout revokes the presented refresh token
  - access token still authenticates /auth/me

Run with the server up:  python test_auth_tokens.py
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
        email = f"tok_{uuid.uuid4().hex[:8]}@t.com"

        print("[signup issues both tokens]")
        r = c.post("/auth/signup", json={"email": email, "password": "secret123", "display_name": "Tok"})
        check("signup -> 201", r.status_code == 201, r.status_code)
        body = r.json()
        access, refresh = body.get("token"), body.get("refresh_token")
        check("signup returns access token", bool(access))
        check("signup returns refresh token", bool(refresh))
        check("access token authenticates /me",
              c.get("/auth/me", headers={"Authorization": f"Bearer {access}"}).status_code == 200)

        print("\n[refresh rotates]")
        r = c.post("/auth/refresh", json={"refresh_token": refresh})
        check("refresh -> 200", r.status_code == 200, r.status_code)
        new_access = r.json().get("token") if r.status_code == 200 else None
        new_refresh = r.json().get("refresh_token") if r.status_code == 200 else None
        check("refresh returns new access token", bool(new_access))
        check("refresh returns new (rotated) refresh token", bool(new_refresh) and new_refresh != refresh)
        check("new access token works on /me",
              c.get("/auth/me", headers={"Authorization": f"Bearer {new_access}"}).status_code == 200)

        print("\n[rotation + reuse detection]")
        # The ORIGINAL refresh token was rotated -> revoked. Reusing it must 401
        # AND (theft mitigation) revoke the whole family, killing new_refresh too.
        r = c.post("/auth/refresh", json={"refresh_token": refresh})
        check("reuse of rotated token -> 401", r.status_code == 401, r.status_code)
        r = c.post("/auth/refresh", json={"refresh_token": new_refresh})
        check("family revoked after reuse: rotated child -> 401", r.status_code == 401, r.status_code)
        r = c.post("/auth/refresh", json={"refresh_token": "not-a-real-token"})
        check("garbage token -> 401", r.status_code == 401, r.status_code)

        print("\n[login + logout]")
        r = c.post("/auth/login", json={"email": email, "password": "secret123"})
        check("login -> 200 with refresh token", r.status_code == 200 and bool(r.json().get("refresh_token")), r.status_code)
        login_refresh = r.json()["refresh_token"]
        r = c.post("/auth/logout", json={"refresh_token": login_refresh})
        check("logout -> 200", r.status_code == 200, r.status_code)
        r = c.post("/auth/refresh", json={"refresh_token": login_refresh})
        check("refresh after logout -> 401", r.status_code == 401, r.status_code)
        r = c.post("/auth/logout", json={"refresh_token": login_refresh})
        check("logout is idempotent -> 200", r.status_code == 200, r.status_code)

    print("\n" + "=" * 56)
    if _fail:
        print("FAILED:", ", ".join(_fail)); print("=" * 56); sys.exit(1)
    print("ALL AUTH / REFRESH-TOKEN CHECKS PASSED"); print("=" * 56)


if __name__ == "__main__":
    main()
