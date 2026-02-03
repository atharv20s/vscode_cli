"""
Lifecycle hooks for the agent.
"""

from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, Callable, Awaitable
from dataclasses import dataclass
from enum import Enum


class HookType(str, Enum):
    """Types of lifecycle hooks."""
    BEFORE_REQUEST = "before_request"
    AFTER_REQUEST = "after_request"
    BEFORE_TOOL = "before_tool"
    AFTER_TOOL = "after_tool"
    ON_ERROR = "on_error"
    ON_STREAM_START = "on_stream_start"
    ON_STREAM_END = "on_stream_end"


@dataclass
class HookContext:
    """Context passed to hooks."""
    hook_type: HookType
    data: dict[str, Any]


class Hook(ABC):
    """Base class for hooks."""
    
    @property
    @abstractmethod
    def hook_type(self) -> HookType:
        """The type of hook."""
        pass
    
    @abstractmethod
    async def execute(self, context: HookContext) -> None:
        """Execute the hook."""
        pass


class HookManager:
    """Manages lifecycle hooks."""
    
    def __init__(self):
        self._hooks: dict[HookType, list[Hook | Callable]] = {
            hook_type: [] for hook_type in HookType
        }
    
    def register(self, hook_type: HookType, hook: Hook | Callable) -> None:
        """Register a hook for a lifecycle event."""
        self._hooks[hook_type].append(hook)
    
    def unregister(self, hook_type: HookType, hook: Hook | Callable) -> None:
        """Unregister a hook."""
        if hook in self._hooks[hook_type]:
            self._hooks[hook_type].remove(hook)
    
    async def trigger(self, hook_type: HookType, **data) -> None:
        """Trigger all hooks for a lifecycle event."""
        context = HookContext(hook_type=hook_type, data=data)
        
        for hook in self._hooks[hook_type]:
            if isinstance(hook, Hook):
                await hook.execute(context)
            elif callable(hook):
                result = hook(context)
                if isinstance(result, Awaitable):
                    await result
    
    def on(self, hook_type: HookType) -> Callable:
        """Decorator to register a function as a hook."""
        def decorator(func: Callable) -> Callable:
            self.register(hook_type, func)
            return func
        return decorator
