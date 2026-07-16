import logging

from app.services.ask_ai.provider import LLMProvider
from app.services.ask_ai.context_manager import ContextManager
from app.services.ask_ai.prompt import build_messages
from app.services.ask_ai.token_manager import TokenManager
from app.services.ask_ai.model_registry import ModelRegistry
from app.services.ask_ai.session_manager import SessionManager
from app.services.ask_ai.rate_limiter import RateLimiter
from app.services.ask_ai.exceptions import ContextWindowExceededError

logger = logging.getLogger("docolab.pipeline")


class LLMPipeline:

    def __init__(self):
        self.provider = LLMProvider()
        self.token_manager = TokenManager()
        self.context_manager = ContextManager()

    def generate(
        self,
        query: str,
        context: str = "",
        model: str | None = None,
        session_id: str | None = None,
    ) -> dict:
        """
        Runs the full ask-ai flow:
          1. resolve model (falls back to default_model if not given)
          2. load prior conversation turns for session_id
          3. count context tokens; if the full prompt would exceed the
             model's context window, summarize the context and retry once
          4. enforce per-model rate limits (rpm/rpd/tpm/tpd), shared across
             all concurrent users of that model
          5. call the provider
          6. persist this turn into the session history

        Returns a dict ready to serialize as AskResponse.
        """
        model = ModelRegistry.resolve(model)
        model_config = ModelRegistry.get_model_config(model)
        litellm_model = model_config["model"]

        history = SessionManager.get_history(session_id)
        context_compressed = False

        messages = build_messages(context=context, query=query, history=history)
        input_tokens = self.token_manager.count_message_tokens(litellm_model, messages)

        try:
            self.context_manager.validate(model=model, input_tokens=input_tokens)
        except ContextWindowExceededError:
            if not context:
                # No context to compress, the query + history alone is too big.
                raise

            logger.info("Context exceeds window for %s, compressing.", model)
            context = self.context_manager.compress_context(model=model, context=context)
            context_compressed = True

            messages = build_messages(context=context, query=query, history=history)
            input_tokens = self.token_manager.count_message_tokens(litellm_model, messages)

            # Raises ContextWindowExceededError again if still too large,
            # which propagates up as a 422 to the caller.
            self.context_manager.validate(model=model, input_tokens=input_tokens)

        rate_limit_cfg = ModelRegistry.get_rate_limit_config(model)
        RateLimiter.check_and_consume(model=model, rate_limit_cfg=rate_limit_cfg, tokens=input_tokens)

        result = self.provider.generate(model=model, messages=messages)
        response_text = result["text"]

        SessionManager.append_turn(session_id=session_id, query=query, response=response_text)

        # Prefer the vendor's reported prompt tokens over our pre-call estimate;
        # they are what the provider actually billed. Fall back to the estimate
        # when the vendor omits usage.
        return {
            "response": response_text,
            "model": model,
            "session_id": session_id,
            "input_tokens": result["input_tokens"] or input_tokens,
            "output_tokens": result["output_tokens"],
            "context_compressed": context_compressed,
        }
