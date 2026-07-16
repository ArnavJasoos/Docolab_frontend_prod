"""Entry point mirroring backend/run.py: `python run.py` starts the service.

Port defaults to 8001 locally (the main backend owns 8000). Hosted platforms
(Render etc.) assign the listen port via $PORT and route health checks to it;
the frontend's ASK_AI_URL env var must point at this host:port.
"""

import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

# Always run from this directory regardless of where `python run.py` was
# invoked (e.g. a host's start command running at the repo root), so the
# `app`/`src` modules import and `.env` (local dev only) is found.
BASE_DIR = Path(__file__).resolve().parent
os.chdir(BASE_DIR)

load_dotenv()

if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8001")),
        app_dir=str(BASE_DIR),
    )
