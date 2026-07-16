"""
Resolves 'provider:model_key' identifiers (e.g. 'groq:llama_70b') against
config.yaml and exposes a single validated place to fetch model settings,
provider API keys, and rate-limit config.
"""

from src.utils.config import Config
from src.llm.exceptions import InvalidModelError


class ModelRegistry:

    @staticmethod
    def default_model() -> str:
        return Config.load()["default_model"]

    @staticmethod
    def resolve(model: str | None) -> str:
        """Returns a valid 'provider:model_key' string, falling back to default."""
        return model.strip() if model else ModelRegistry.default_model()

    @staticmethod
    def get_model_config(model: str) -> dict:
        config = Config.load()

        if ":" not in model:
            raise InvalidModelError(model)

        provider, model_key = model.split(":", 1)

        provider_models = config.get("models", {}).get(provider)
        if not provider_models or model_key not in provider_models:
            raise InvalidModelError(model)

        return provider_models[model_key]

    @staticmethod
    def get_api_key(model: str) -> str:
        config = Config.load()
        provider = model.split(":", 1)[0]

        provider_cfg = config.get("providers", {}).get(provider)
        if not provider_cfg or not provider_cfg.get("api_key"):
            raise InvalidModelError(model)

        return provider_cfg["api_key"]

    @staticmethod
    def get_rate_limit_config(model: str) -> dict:
        model_config = ModelRegistry.get_model_config(model)
        return model_config.get("rate_limit", {})

    @staticmethod
    def list_available_models() -> list[str]:
        config = Config.load()
        result = []
        for provider, models in config.get("models", {}).items():
            for model_key in models:
                result.append(f"{provider}:{model_key}")
        return result
