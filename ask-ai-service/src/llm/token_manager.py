from litellm import token_counter


class TokenManager:
    """
    Counts tokens using the underlying provider model's tokenizer (e.g.
    'groq/llama-3.3-70b-versatile'), not the internal 'provider:model_key'
    registry identifier.
    """

    @staticmethod
    def count_text_tokens(litellm_model: str, text: str) -> int:
        if not text:
            return 0
        return token_counter(model=litellm_model, text=text)

    @staticmethod
    def count_message_tokens(litellm_model: str, messages: list) -> int:
        return token_counter(model=litellm_model, messages=messages)
