from pathlib import Path
import os
from dotenv import load_dotenv
import yaml

load_dotenv()

def expand_env(obj):
    if isinstance(obj, dict):
        return {k: expand_env(v) for k, v in obj.items()}
    elif isinstance(obj, str):
        return os.path.expandvars(obj)
    return obj

class Config:

    _config = None

    @classmethod
    def load(cls):

        if cls._config is None:
            config_path = Path(__file__).parent.parent.parent / "config.yaml"
            with open(config_path, "r") as f:
                cls._config = yaml.safe_load(f)
            cls._config = expand_env(cls._config)

        return cls._config
