"""
Conversation history management.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any
from datetime import datetime


@dataclass
class Message:
    """A single message in the conversation."""
    role: str  # 'system', 'user', 'assistant', 'tool'
    content: str
    timestamp: datetime = field(default_factory=datetime.now)
    metadata: dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> dict[str, str]:
        """Convert to API message format."""
        return {"role": self.role, "content": self.content}


class ConversationHistory:
    """Manages conversation history with support for context windowing."""
    
    def __init__(self, max_messages: int = 50):
        """Initialize conversation history.
        
        Args:
            max_messages: Maximum number of messages to keep in history
        """
        self.messages: list[Message] = []
        self.max_messages = max_messages
        self._system_prompt: str | None = None
    
    def set_system_prompt(self, prompt: str) -> None:
        """Set the system prompt (persists across clears)."""
        self._system_prompt = prompt
        # Ensure system prompt is first message
        if not self.messages or self.messages[0].role != "system":
            self.messages.insert(0, Message(role="system", content=prompt))
        else:
            self.messages[0] = Message(role="system", content=prompt)
    
    def add_user_message(self, content: str) -> Message:
        """Add a user message to history."""
        msg = Message(role="user", content=content)
        self.messages.append(msg)
        self._trim_if_needed()
        return msg
    
    def add_assistant_message(self, content: str) -> Message:
        """Add an assistant message to history."""
        msg = Message(role="assistant", content=content)
        self.messages.append(msg)
        self._trim_if_needed()
        return msg
    
    def add_tool_message(self, content: str, tool_name: str) -> Message:
        """Add a tool result message to history."""
        msg = Message(
            role="tool",
            content=content,
            metadata={"tool_name": tool_name}
        )
        self.messages.append(msg)
        self._trim_if_needed()
        return msg
    
    def get_messages(self) -> list[dict[str, str]]:
        """Get all messages in API format."""
        return [msg.to_dict() for msg in self.messages]
    
    def get_last_n(self, n: int) -> list[dict[str, str]]:
        """Get the last N messages (always includes system prompt)."""
        if not self.messages:
            return []
        
        # Always include system prompt if present
        if self.messages[0].role == "system":
            system = [self.messages[0].to_dict()]
            others = [msg.to_dict() for msg in self.messages[-n:] if msg.role != "system"]
            return system + others
        
        return [msg.to_dict() for msg in self.messages[-n:]]
    
    def clear(self, keep_system: bool = True) -> None:
        """Clear conversation history."""
        if keep_system and self._system_prompt:
            self.messages = [Message(role="system", content=self._system_prompt)]
        else:
            self.messages = []
    
    def _trim_if_needed(self) -> None:
        """Trim history if it exceeds max_messages."""
        if len(self.messages) > self.max_messages:
            # Keep system prompt if present
            if self.messages[0].role == "system":
                system = self.messages[0]
                self.messages = [system] + self.messages[-(self.max_messages - 1):]
            else:
                self.messages = self.messages[-self.max_messages:]
    
    def __len__(self) -> int:
        return len(self.messages)
    
    def __repr__(self) -> str:
        return f"ConversationHistory({len(self.messages)} messages)"
