"""
Resolves 'provider:model_key' identifiers (e.g. 'groq:llama_70b') against
config.yaml and exposes a single validated place to fetch model settings,
provider API keys, and rate-limit config.
"""

from app.services.ask_ai.config import Config
from app.services.ask_ai.exceptions import InvalidModelError, MissingApiKeyError


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
        if not provider_cfg:
            raise InvalidModelError(model)

        api_key = (provider_cfg.get("api_key") or "").strip()
        # An unset ${VAR} survives expansion as the literal placeholder, which is
        # truthy — treat that as "no key" rather than sending it upstream.
        unexpanded = api_key.startswith("${") and api_key.endswith("}")
        if not api_key or unexpanded:
            raise MissingApiKeyError(
                model=model,
                provider=provider,
                env_var=api_key[2:-1] if unexpanded else None,
            )

        return api_key

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

    @staticmethod
    def list_catalog() -> list[dict]:
        """Every configured model as {model_id, vendor, display_name}, where
        model_id is the 'provider:model_key' identifier the pipeline takes.

        This is what seeds the per-org admin catalog (ai_models), so the models
        an admin can assign are exactly the models this router can call.
        """
        config = Config.load()
        catalog = []
        for provider, models in config.get("models", {}).items():
            for model_key, cfg in models.items():
                model_id = f"{provider}:{model_key}"
                catalog.append({
                    "model_id": model_id,
                    "vendor": provider,
                    "display_name": cfg.get("display_name") or model_id,
                })
        return catalog
