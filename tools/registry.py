"""
Tool Registry - Central management for all available tools.

The registry is a singleton that:
- Stores all registered tools
- Provides lookup by name
- Generates tool definitions for LLM
- Handles tool execution
"""

from __future__ import annotations
from typing import Any
from tools.base import Tool, ToolResult, ToolDefinition


class ToolRegistry:
    """
    Central registry for all tools.
    
    Usage:
        registry = ToolRegistry()
        registry.register(MyTool())
        
        # Get tool definitions for LLM
        definitions = registry.get_definitions()
        
        # Execute a tool by name
        result = await registry.execute("tool_name", arg1="value")
    """
    
    _instance: ToolRegistry | None = None
    
    def __new__(cls) -> ToolRegistry:
        """Singleton pattern - only one registry exists."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._tools = {}
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if not hasattr(self, '_initialized') or not self._initialized:
            self._tools: dict[str, Tool] = {}
            self._initialized = True
    
    def register(self, tool: Tool) -> None:
        """Register a tool (overwrites if exists)."""
        self._tools[tool.name] = tool
    
    def register_many(self, tools: list[Tool]) -> None:
        """Register multiple tools at once."""
        for tool in tools:
            self.register(tool)
    
    def unregister(self, name: str) -> bool:
        """Unregister a tool by name. Returns True if removed."""
        if name in self._tools:
            del self._tools[name]
            return True
        return False
    
    def get(self, name: str) -> Tool | None:
        """Get a tool by name."""
        return self._tools.get(name)
    
    def has(self, name: str) -> bool:
        """Check if a tool is registered."""
        return name in self._tools
    
    def list_tools(self) -> list[str]:
        """Get list of all registered tool names."""
        return list(self._tools.keys())
    
    def get_all(self) -> list[Tool]:
        """Get all registered tools."""
        return list(self._tools.values())
    
    def get_definitions(self) -> list[dict[str, Any]]:
        """Get all tool definitions in OpenAI format."""
        return [
            tool.get_definition().to_openai_format()
            for tool in self._tools.values()
        ]
    
    def get_definition(self, name: str) -> ToolDefinition | None:
        """Get a single tool's definition."""
        tool = self.get(name)
        return tool.get_definition() if tool else None
    
    async def execute(self, name: str, **kwargs) -> ToolResult:
        """Execute a tool by name."""
        tool = self.get(name)
        if not tool:
            return ToolResult.fail(f"Unknown tool: {name}")
        
        # Validate parameters
        valid, error = tool.validate_params(**kwargs)
        if not valid:
            return ToolResult.fail(error or "Invalid parameters")
        
        try:
            return await tool.execute(**kwargs)
        except Exception as e:
            return ToolResult.fail(f"Tool execution failed: {str(e)}")
    
    def clear(self) -> None:
        """Remove all registered tools."""
        self._tools.clear()
    
    @classmethod
    def reset(cls) -> None:
        """Reset the singleton instance (for testing)."""
        cls._instance = None
    
    def __len__(self) -> int:
        return len(self._tools)


# Global registry instance
_registry: ToolRegistry | None = None


def get_registry() -> ToolRegistry:
    """Get the global tool registry."""
    global _registry
    if _registry is None:
        _registry = ToolRegistry()
    return _registry


def register_tool(tool: Tool) -> None:
    """Register a tool in the global registry."""
    get_registry().register(tool)


def get_tool(name: str) -> Tool | None:
    """Get a tool from the global registry."""
    return get_registry().get(name)
    
    def __contains__(self, name: str) -> bool:
        return name in self._tools
