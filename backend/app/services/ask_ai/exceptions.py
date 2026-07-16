"""
Custom exceptions for the LLM pipeline.
Each maps to a specific HTTP status code in the API layer.
"""


class ContextWindowExceededError(Exception):
    """Raised when input (context + history + query) exceeds the model's context window."""

    def __init__(self, input_tokens: int, limit_tokens: int, model: str):
        self.input_tokens = input_tokens
        self.limit_tokens = limit_tokens
        self.model = model
        super().__init__(
            f"Input token limit exceeded for model '{model}'. "
            f"input_tokens={input_tokens}, limit={limit_tokens}"
        )


class RateLimitExceededError(Exception):
    """Raised when a model's request/token quota (per minute or per day) is exhausted."""

    def __init__(self, model: str, scope: str, retry_after: float):
        self.model = model
        self.scope = scope  # one of: rpm, rpd, tpm, tpd
        self.retry_after = round(retry_after, 2)
        super().__init__(
            f"Rate limit exceeded for model '{model}' ({scope}). "
            f"Retry after {self.retry_after} seconds."
        )


class ProviderError(Exception):
    """Raised when the underlying LLM provider call fails."""

    def __init__(self, model: str, message: str):
        self.model = model
        super().__init__(f"Provider call failed for model '{model}': {message}")


class InvalidModelError(Exception):
    """Raised when a requested model is not defined in config.yaml."""

    def __init__(self, model: str):
        self.model = model
        super().__init__(f"Model '{model}' is not configured.")


class MissingApiKeyError(Exception):
    """Raised when a model's provider has no API key in the environment.

    Distinct from InvalidModelError: the model is configured correctly, the
    deployment just has no key for its provider. Caught before the vendor call
    so the operator gets 'set GROQ_API_KEY' rather than the vendor's opaque
    'API key not valid' (an unset ${VAR} expands to the literal placeholder,
    which would otherwise be sent upstream as if it were a real key).
    """

    def __init__(self, model: str, provider: str, env_var: str | None = None):
        self.model = model
        self.provider = provider
        self.env_var = env_var
        hint = f" Set {env_var} in backend/.env." if env_var else ""
        super().__init__(
            f"No API key configured for provider '{provider}' (model '{model}').{hint}"
        )
