from src.llm.pipeline import LLMPipeline

result = LLMPipeline().generate(
    context="",
    query="write a brief about the transformer architecture.",
    model="groq:llama_70b",
)

print(result["response"])
