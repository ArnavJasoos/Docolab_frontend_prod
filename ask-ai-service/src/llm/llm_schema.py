from pydantic import BaseModel, Field


class AskRequest(BaseModel):
    query: str = Field(..., min_length=1, description="User question or instruction")
    context: str | None = Field(default=None, description="Optional selected document text")
    model: str | None = Field(default=None, description="'provider:model_key', e.g. 'groq:llama_70b'")
    session_id: str | None = Field(default=None, description="Conversation/session id for multi-turn context")


class AskResponse(BaseModel):
    response: str
    model: str
    session_id: str | None = None
    input_tokens: int
    context_compressed: bool = False


class ErrorResponse(BaseModel):
    error: str
    message: str
    details: dict | None = None


class HealthResponse(BaseModel):
    status: str
    default_model: str
    available_models: list[str]
