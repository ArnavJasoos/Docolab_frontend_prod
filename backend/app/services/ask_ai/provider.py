from litellm import completion

from app.services.ask_ai.model_registry import ModelRegistry
from app.services.ask_ai.exceptions import ProviderError


class LLMProvider:

    def generate(self, model: str, messages: list) -> dict:
        """Call the model and return {text, input_tokens, output_tokens}.

        Token counts come from the vendor's own `usage` block rather than a
        local estimate, so the admin usage metering reflects what was actually
        billed. Providers that omit usage yield zeros — the pipeline falls back
        to its own input estimate in that case.
        """
        model_config = ModelRegistry.get_model_config(model)
        api_key = ModelRegistry.get_api_key(model)

        try:
            response = completion(
                model=model_config["model"],
                messages=messages,
                temperature=model_config["temperature"],
                max_tokens=model_config["max_output_tokens"],
                api_key=api_key,
            )
        except Exception as exc:
            raise ProviderError(model=model, message=str(exc)) from exc

        usage = getattr(response, "usage", None)
        return {
            "text": response.choices[0].message.content.strip(),
            "input_tokens": int(getattr(usage, "prompt_tokens", 0) or 0),
            "output_tokens": int(getattr(usage, "completion_tokens", 0) or 0),
        }
