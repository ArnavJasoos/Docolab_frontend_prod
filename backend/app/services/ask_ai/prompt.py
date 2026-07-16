from app.services.ask_ai.prompt_templates import DOC_PROMPT, NO_CONTEXT_PROMPT


def build_messages(context: str, query: str, history: list | None = None) -> list:
    """
    Builds the message list sent to the LLM.

    - If context is provided, the model is instructed to answer strictly
      from it (grounded document Q&A / continuation).
    - If context is empty, the model answers the query as a general
      request (e.g. "write a brief about transformers").
    - Prior conversation turns (history) are inserted between the system
      prompt and the current user turn so multi-turn sessions stay coherent.
    """
    context = (context or "").strip()
    query = (query or "").strip()

    if context:
        system_prompt = DOC_PROMPT
        user_content = f"""Context:
{context}

Question:
{query}
"""
    else:
        system_prompt = NO_CONTEXT_PROMPT
        user_content = query

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history or [])
    messages.append({"role": "user", "content": user_content})

    return messages
