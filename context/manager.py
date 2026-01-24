"""
Context manager for handling conversation state and context windowing.
"""

from __future__ import annotations
from typing import Any
from context.history import ConversationHistory


class ContextManager:
    """Manages conversation context, including history and metadata."""
    
    def __init__(
        self,
        max_history: int = 50,
        max_tokens: int = 8000,
    ):
        """Initialize the context manager.
        
        Args:
            max_history: Maximum number of messages in history
            max_tokens: Approximate maximum tokens for context (for future use)
        """
        self.history = ConversationHistory(max_messages=max_history)
        self.max_tokens = max_tokens
        self.metadata: dict[str, Any] = {}
    
    def set_system_prompt(self, prompt: str) -> None:
        """Set the system prompt for the conversation."""
        self.history.set_system_prompt(prompt)
    
    def add_user_message(self, content: str) -> None:
        """Add a user message."""
        self.history.add_user_message(content)
    
    def add_assistant_message(self, content: str) -> None:
        """Add an assistant message."""
        self.history.add_assistant_message(content)
    
    def get_context(self) -> list[dict[str, str]]:
        """Get the current conversation context for API calls."""
        return self.history.get_messages()
    
    def get_windowed_context(self, n: int = 10) -> list[dict[str, str]]:
        """Get a windowed context with the last N messages."""
        return self.history.get_last_n(n)
    
    def reset(self, keep_system: bool = True) -> None:
        """Reset the conversation context."""
        self.history.clear(keep_system=keep_system)
        self.metadata = {}
    
    def set_metadata(self, key: str, value: Any) -> None:
        """Set a metadata value."""
        self.metadata[key] = value
    
    def get_metadata(self, key: str, default: Any = None) -> Any:
        """Get a metadata value."""
        return self.metadata.get(key, default)
