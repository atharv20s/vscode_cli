"""
Base tool definitions and interfaces for the Agentic CLI.

This module provides the foundation for all tools:
- ToolResult: Standardized result format
- ToolDefinition: Schema for LLM function calling
- Tool: Abstract base class for implementing tools
- FunctionTool: Create tools from simple async functions
- @tool decorator: Easy tool creation
"""

from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable
from enum import Enum


class ToolStatus(Enum):
    """Status of a tool execution."""
    SUCCESS = "success"
    FAILURE = "failure"
    PENDING = "pending"
    CANCELLED = "cancelled"


@dataclass
class ToolResult:
    """
    Result from a tool execution.
    
    Attributes:
        success: Whether the tool executed successfully
        output: The tool's output (for display to user or LLM)
        error: Error message if failed
        metadata: Additional data (timing, resource usage, etc.)
    """
    success: bool
    output: str
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    
    @classmethod
    def ok(cls, output: str, **metadata) -> ToolResult:
        """Create a successful result."""
        return cls(success=True, output=output, metadata=metadata)
    
    @classmethod
    def fail(cls, error: str, **metadata) -> ToolResult:
        """Create a failed result."""
        return cls(success=False, output="", error=error, metadata=metadata)
    
    def to_message(self) -> str:
        """Convert result to a message for the LLM."""
        if self.success:
            return self.output
        return f"Error: {self.error}"


@dataclass
class ToolParameter:
    """Definition of a single tool parameter."""
    name: str
    type: str  # "string", "integer", "boolean", "array", "object"
    description: str
    required: bool = False
    default: Any = None
    enum: list[str] | None = None
    
    def to_schema(self) -> dict[str, Any]:
        """Convert to JSON Schema format."""
        schema: dict[str, Any] = {
            "type": self.type,
            "description": self.description,
        }
        if self.enum:
            schema["enum"] = self.enum
        if self.default is not None:
            schema["default"] = self.default
        return schema


@dataclass
class ToolDefinition:
    """
    Definition of a tool for the LLM.
    
    This follows the OpenAI function calling format.
    """
    name: str
    description: str
    parameters: dict[str, Any]
    required: list[str] = field(default_factory=list)
    
    def to_openai_format(self) -> dict[str, Any]:
        """Convert to OpenAI function calling format."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": self.parameters,
                    "required": self.required,
                }
            }
        }
    
    @classmethod
    def from_parameters(
        cls,
        name: str,
        description: str,
        params: list[ToolParameter],
    ) -> ToolDefinition:
        """Create from a list of ToolParameter objects."""
        properties = {p.name: p.to_schema() for p in params}
        required = [p.name for p in params if p.required]
        return cls(
            name=name,
            description=description,
            parameters=properties,
            required=required,
        )


class Tool(ABC):
    """
    Abstract base class for all tools.
    
    To create a new tool:
    1. Subclass Tool
    2. Implement name, description, parameters properties
    3. Implement the execute() async method
    
    Example:
        class CalculatorTool(Tool):
            @property
            def name(self) -> str:
                return "calculator"
            
            @property
            def description(self) -> str:
                return "Perform basic math operations"
            
            @property
            def parameters(self) -> dict[str, Any]:
                return {
                    "expression": {
                        "type": "string",
                        "description": "Math expression to evaluate"
                    }
                }
            
            @property
            def required_params(self) -> list[str]:
                return ["expression"]
            
            async def execute(self, expression: str) -> ToolResult:
                try:
                    result = eval(expression)
                    return ToolResult.ok(str(result))
                except Exception as e:
                    return ToolResult.fail(str(e))
    """
    
    @property
    @abstractmethod
    def name(self) -> str:
        """The tool's unique name (used in function calls)."""
        pass
    
    @property
    @abstractmethod
    def description(self) -> str:
        """A description of what the tool does (shown to LLM)."""
        pass
    
    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]:
        """JSON Schema for the tool's parameters."""
        pass
    
    @property
    def required_params(self) -> list[str]:
        """List of required parameter names."""
        return []
    
    @property
    def is_dangerous(self) -> bool:
        """Whether this tool can cause side effects (file writes, shell commands)."""
        return False
    
    @property
    def requires_confirmation(self) -> bool:
        """Whether to ask user confirmation before executing."""
        return self.is_dangerous
    
    def get_definition(self) -> ToolDefinition:
        """Get the tool definition for the LLM."""
        return ToolDefinition(
            name=self.name,
            description=self.description,
            parameters=self.parameters,
            required=self.required_params,
        )
    
    def validate_params(self, **kwargs) -> tuple[bool, str | None]:
        """Validate parameters before execution."""
        for param in self.required_params:
            if param not in kwargs or kwargs[param] is None:
                return False, f"Missing required parameter: {param}"
        return True, None
    
    @abstractmethod
    async def execute(self, **kwargs) -> ToolResult:
        """
        Execute the tool with the given arguments.
        
        Args:
            **kwargs: Tool-specific arguments
            
        Returns:
            ToolResult: The result of execution
        """
        pass


class FunctionTool(Tool):
    """
    A tool created from a simple async function.
    
    Usage:
        async def get_weather(city: str) -> str:
            return f"Weather in {city}: Sunny"
        
        tool = FunctionTool.create(
            name="get_weather",
            description="Get current weather",
            func=get_weather,
            parameters={"city": {"type": "string", "description": "City name"}},
            required=["city"]
        )
    """
    
    def __init__(
        self,
        name: str,
        description: str,
        func: Callable[..., Awaitable[str | ToolResult]],
        parameters: dict[str, Any],
        required: list[str] | None = None,
        dangerous: bool = False,
    ):
        self._name = name
        self._description = description
        self._func = func
        self._parameters = parameters
        self._required = required or []
        self._dangerous = dangerous
    
    @property
    def name(self) -> str:
        return self._name
    
    @property
    def description(self) -> str:
        return self._description
    
    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters
    
    @property
    def required_params(self) -> list[str]:
        return self._required
    
    @property
    def is_dangerous(self) -> bool:
        return self._dangerous
    
    async def execute(self, **kwargs) -> ToolResult:
        """Execute the wrapped function."""
        try:
            result = await self._func(**kwargs)
            if isinstance(result, ToolResult):
                return result
            return ToolResult.ok(str(result))
        except Exception as e:
            return ToolResult.fail(str(e))
    
    @classmethod
    def create(
        cls,
        name: str,
        description: str,
        func: Callable[..., Awaitable[str | ToolResult]],
        parameters: dict[str, Any],
        required: list[str] | None = None,
        dangerous: bool = False,
    ) -> FunctionTool:
        """Factory method for creating a FunctionTool."""
        return cls(
            name=name,
            description=description,
            func=func,
            parameters=parameters,
            required=required,
            dangerous=dangerous,
        )


def tool(
    name: str | None = None,
    description: str | None = None,
    parameters: dict[str, Any] | None = None,
    required: list[str] | None = None,
    dangerous: bool = False,
) -> Callable[[Callable], FunctionTool]:
    """
    Decorator to create a tool from an async function.
    
    Usage:
        @tool(
            name="search",
            description="Search the web",
            parameters={"query": {"type": "string", "description": "Search query"}},
            required=["query"]
        )
        async def search(query: str) -> str:
            return f"Results for: {query}"
    """
    def decorator(func: Callable[..., Awaitable[str | ToolResult]]) -> FunctionTool:
        tool_name = name or func.__name__
        tool_desc = description or func.__doc__ or "No description"
        tool_params = parameters or {}
        
        return FunctionTool.create(
            name=tool_name,
            description=tool_desc,
            func=func,
            parameters=tool_params,
            required=required,
            dangerous=dangerous,
        )
    
    return decorator
