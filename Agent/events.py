"""
Agent event types and data structures.
"""

from __future__ import annotations

from enum import Enum
from dataclasses import dataclass, field
from typing import Any
from CLIENT.response import TokenUsage


class AgentEventType(str, Enum):
    """All possible event types in the agentic loop."""
    
    # Agent lifecycle events
    AGENT_START = "agent_started"
    AGENT_END = "agent_end"
    AGENT_ERROR = "agent_error"
    
    # Turn tracking
    TURN_START = "turn_start"  # New turn in agentic loop
    
    # Text streaming
    TEXT_DELTA = "text_delta"
    TEXT_COMPLETE = "text_complete"
    
    # Tool events
    TOOL_CALL = "tool_call"           # LLM wants to call a tool
    TOOL_EXECUTING = "tool_executing"  # Tool is being executed
    TOOL_RESULT = "tool_result"        # Tool execution completed
    TOOL_ERROR = "tool_error"          # Tool execution failed


@dataclass
class ToolCall:
    """Represents a tool call from the LLM."""
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class AgentEvent:
    type: AgentEventType
    data: dict[str, Any] = field(default_factory=dict)
    
    @classmethod
    def agent_start(cls, message: str) -> AgentEvent:
        return cls(
            type=AgentEventType.AGENT_START,
            data={"message": message}
        )
    
    @classmethod
    def agent_end(cls, response: str | None = None, usage: TokenUsage | None = None) -> AgentEvent:
        return cls(
            type=AgentEventType.AGENT_END,
            data={
                "response": response,
                "usage": usage.__dict__ if usage else None,
            },
        )
    
    @classmethod
    def agent_error(cls, error: str, details: dict[str, Any] | None = None) -> AgentEvent:
        return cls(
            type=AgentEventType.AGENT_ERROR,
            data={"error": error, "details": details or {}}
        )
    
    @classmethod
    def text_delta(cls, content: str) -> AgentEvent:
        return cls(
            type=AgentEventType.TEXT_DELTA,
            data={"content": content}
        )
    
    @classmethod
    def text_complete(cls, content: str) -> AgentEvent:
        return cls(
            type=AgentEventType.TEXT_COMPLETE,
            data={"content": content}
        )
    
    @classmethod
    def tool_call(cls, tool_call: ToolCall) -> AgentEvent:
        """LLM is requesting to call a tool."""
        return cls(
            type=AgentEventType.TOOL_CALL,
            data={
                "id": tool_call.id,
                "name": tool_call.name,
                "arguments": tool_call.arguments,
            }
        )
    
    @classmethod
    def tool_executing(cls, name: str, arguments: dict[str, Any]) -> AgentEvent:
        """Tool execution has started."""
        return cls(
            type=AgentEventType.TOOL_EXECUTING,
            data={"name": name, "arguments": arguments}
        )
    
    @classmethod
    def tool_result(
        cls,
        tool_id: str,
        name: str,
        result: str,
        success: bool = True,
    ) -> AgentEvent:
        """Tool execution completed."""
        return cls(
            type=AgentEventType.TOOL_RESULT,
            data={
                "id": tool_id,
                "name": name,
                "result": result,
                "success": success,
            }
        )
    
    @classmethod
    def tool_error(cls, tool_id: str, name: str, error: str) -> AgentEvent:
        """Tool execution failed."""
        return cls(
            type=AgentEventType.TOOL_ERROR,
            data={
                "id": tool_id,
                "name": name,
                "error": error,
            }
        )
    
    @classmethod
    def turn_start(cls, turn: int, max_turns: int) -> AgentEvent:
        """A new turn in the agentic loop has started."""
        return cls(
            type=AgentEventType.TURN_START,
            data={
                "turn": turn,
                "max_turns": max_turns,
            }
        )