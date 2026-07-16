from litellm import completion
from dotenv import load_dotenv

from src.llm.model_registry import ModelRegistry
from src.llm.exceptions import ProviderError

load_dotenv()


class LLMProvider:

    def generate(self, model: str, messages: list) -> str:
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

        return response.choices[0].message.content.strip()
