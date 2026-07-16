from fastapi import FastAPI
from src.api.router import router

app = FastAPI(
    title="DocoLab Ask-AI Service",
    version="1.0.0",
    description="Ask-AI feature backend: context-aware LLM Q&A with rate limiting and session management.",
)

app.include_router(router)
