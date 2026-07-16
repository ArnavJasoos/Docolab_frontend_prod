from litellm import completion

from app.services.ask_ai.model_registry import ModelRegistry
from app.services.ask_ai.prompt_templates import SUMMARY_PROMPT
from app.services.ask_ai.exceptions import ContextWindowExceededError, ProviderError


class ContextManager:

    def validate(self, model: str, input_tokens: int):
        """
        Validate whether the input fits inside the model's context window.
        Raises ContextWindowExceededError (mapped to HTTP 422) if not.
        """
        model_config = ModelRegistry.get_model_config(model)
        context_window = model_config["context_window"]

        if input_tokens > context_window:
            raise ContextWindowExceededError(
                input_tokens=input_tokens,
                limit_tokens=context_window,
                model=model,
            )

        return True

    def compress_context(self, model: str, context: str) -> str:
        """
        Summarize the context using the same model so it fits the context
        window. Used when the raw context alone is too large.
        """
        model_config = ModelRegistry.get_model_config(model)
        api_key = ModelRegistry.get_api_key(model)

        try:
            response = completion(
                model=model_config["model"],
                messages=[
                    {"role": "system", "content": SUMMARY_PROMPT},
                    {"role": "user", "content": context},
                ],
                temperature=0.0,
                max_tokens=model_config["max_output_tokens"] // 2,
                api_key=api_key,
            )
        except Exception as exc:
            raise ProviderError(model=model, message=f"context summarization failed: {exc}") from exc

        return response.choices[0].message.content.strip()
