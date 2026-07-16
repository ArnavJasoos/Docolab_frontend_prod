"""Loads the Ask-AI model catalog (config.yaml) with ${ENV_VAR} expansion.

Vendor API keys are never written here — config.yaml references them as
${GROQ_API_KEY} etc. and they are expanded from backend/.env at load time.
Importing app.core.config first guarantees .env is already loaded no matter
which entry point (run.py, alembic, a test script) pulled us in.
"""

import os
from pathlib import Path

import yaml

import app.core.config  # noqa: F401  — import side effect: loads backend/.env

CONFIG_PATH = Path(__file__).resolve().parent / "config.yaml"


def expand_env(obj):
    if isinstance(obj, dict):
        return {k: expand_env(v) for k, v in obj.items()}
    if isinstance(obj, str):
        return os.path.expandvars(obj)
    return obj


class Config:

    _config = None

    @classmethod
    def load(cls):
        if cls._config is None:
            with open(CONFIG_PATH, "r") as f:
                cls._config = expand_env(yaml.safe_load(f))
        return cls._config
