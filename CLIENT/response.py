from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


@dataclass
class TextDelta:
    """Represents a text delta from streaming response."""
    content: str
    
    def __str__(self):
        return self.content


@dataclass
class ToolCallDelta:
    """Represents a tool call from the LLM."""
    id: str
    name: str
    arguments: str  # JSON string of arguments


class StreamEventType(str, Enum):
    """Types of events from streaming LLM responses."""
    TEXT_DELTA = "text_delta"
    TOOL_CALL = "tool_call"
    MESSAGE_COMPLETE = "message_complete"
    ERROR = "error"


@dataclass
class TokenUsage:
    """Token usage statistics."""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0
    
    def __add__(self, other: TokenUsage):
        return TokenUsage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
            total_tokens=self.total_tokens + other.total_tokens,
            cached_tokens=self.cached_tokens + other.cached_tokens,
        )


@dataclass
class StreamEvent:
    """Event from an LLM streaming response."""
    type: StreamEventType
    text_delta: TextDelta | None = None
    tool_calls: list[ToolCallDelta] = field(default_factory=list)
    error: str | None = None
    finish_reason: str | None = None
    usage: TokenUsage | None = None


