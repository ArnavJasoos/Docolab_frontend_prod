import os
from pathlib import Path

import uvicorn

# Always run from the backend/ directory, regardless of where `python run.py`
# is invoked from. This makes `app.main` importable (so --reload's worker can
# import the app) and keeps relative paths stable. The in-process alembic
# auto-migrate on startup uses an absolute path, so it works either way.
BASE_DIR = Path(__file__).resolve().parent
os.chdir(BASE_DIR)

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",   # serves on localhost:8000 (and other interfaces)
        port=8000,
        reload=True,
        app_dir=str(BASE_DIR),
    )