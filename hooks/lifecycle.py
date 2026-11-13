"""
Lifecycle hooks for the Python agent runtime.

Before hooks may veto an action. A veto or exception is fail-closed when
trigger(..., fail_closed=True) is used. After hooks are observational by
default and may report errors without changing the completed operation.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, Callable
from dataclasses import dataclass, field
from enum import Enum
import inspect


class HookType(str, Enum):
    BEFORE_REQUEST = "before_request"
    AFTER_REQUEST = "after_request"
    BEFORE_TOOL = "before_tool"
    AFTER_TOOL = "after_tool"
    ON_ERROR = "on_error"
    ON_STREAM_START = "on_stream_start"
    ON_STREAM_END = "on_stream_end"


@dataclass
class HookContext:
    hook_type: HookType
    data: dict[str, Any]
    blocked: bool = False
    block_reason: str = ""
    errors: list[str] = field(default_factory=list)


class HookBlockedError(RuntimeError):
    """Raised when a fail-closed lifecycle hook denies an action."""


class Hook(ABC):
    @property
    @abstractmethod
    def hook_type(self) -> HookType:
        pass

    @abstractmethod
    async def execute(self, context: HookContext) -> None:
        pass


class HookManager:
    """Per-agent hook registry; handlers execute in registration order."""

    def __init__(self):
        self._hooks: dict[HookType, list[Hook | Callable]] = {
            hook_type: [] for hook_type in HookType
        }

    def register(self, hook_type: HookType, hook: Hook | Callable) -> None:
        if not isinstance(hook_type, HookType):
            raise TypeError("hook_type must be a HookType")
        if not isinstance(hook, Hook) and not callable(hook):
            raise TypeError("hook must be a Hook or callable")
        self._hooks[hook_type].append(hook)

    def unregister(self, hook_type: HookType, hook: Hook | Callable) -> bool:
        try:
            self._hooks[hook_type].remove(hook)
            return True
        except (KeyError, ValueError):
            return False

    async def trigger(self, hook_type: HookType, *, fail_closed: bool = False, **data) -> HookContext:
        context = HookContext(hook_type=hook_type, data=data)
        for hook in tuple(self._hooks[hook_type]):
            try:
                if isinstance(hook, Hook):
                    result = await hook.execute(context)
                else:
                    result = hook(context)
                    if inspect.isawaitable(result):
                        result = await result
                if result is False:
                    context.blocked = True
                elif isinstance(result, dict):
                    if result.get("blocked") is True:
                        context.blocked = True
                    if isinstance(result.get("reason"), str):
                        context.block_reason = result["reason"]
            except Exception as error:
                context.errors.append(str(error))
                if fail_closed:
                    raise HookBlockedError(
                        f"{hook_type.value} hook failed; action blocked: {error}"
                    ) from error
        if fail_closed and context.blocked:
            raise HookBlockedError(context.block_reason or f"Action blocked by {hook_type.value} hook.")
        return context

    def clear(self) -> None:
        for hooks in self._hooks.values():
            hooks.clear()

    def on(self, hook_type: HookType) -> Callable:
        def decorator(func: Callable) -> Callable:
            self.register(hook_type, func)
            return func
        return decorator
