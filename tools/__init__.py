"""
Tools package - Extensible tool system for the Agentic CLI.

Available Tools (9):
- read_file: Read file contents
- write_file: Write/create files
- edit_file: Find and replace text in files
- list_dir: List directory contents
- shell: Execute shell commands
- grep: Search text patterns inside files
- glob: Find files by name pattern
- web_search: Search via DuckDuckGo
- fetch_url: Fetch URL content

Last updated: January 24, 2026

This package provides:
- Base classes for creating tools (Tool, FunctionTool)
- Tool registry for managing available tools
- Auto-discovery of tools from builtin/ and custom paths
- MCP integration for external tool servers
- Subagent tools for complex autonomous tasks

Quick Start:
    from tools import get_registry, setup_tools
    from tools.base import tool
    
    # Setup all available tools
    registry = setup_tools()
    
    # Create a custom tool with decorator
    @tool(
        name="greet",
        description="Greet someone",
        parameters={"name": {"type": "string", "description": "Name"}},
        required=["name"]
    )
    async def greet(name: str) -> str:
        return f"Hello, {name}!"
    
    # Register it
    registry.register(greet)
    
    # Execute a tool
    result = await registry.execute("greet", name="World")
    print(result.output)  # "Hello, World!"
"""

from tools.base import (
    Tool,
    ToolResult,
    ToolDefinition,
    ToolParameter,
    ToolStatus,
    FunctionTool,
    tool,
)
from tools.registry import (
    ToolRegistry,
    get_registry,
    register_tool,
    get_tool,
)
from tools.discovery import (
    ToolDiscovery,
    discover_all_tools,
    setup_tools,
)

__all__ = [
    # Base
    "Tool",
    "ToolResult",
    "ToolDefinition",
    "ToolParameter",
    "ToolStatus",
    "FunctionTool",
    "tool",
    # Registry
    "ToolRegistry",
    "get_registry",
    "register_tool",
    "get_tool",
    # Discovery
    "ToolDiscovery",
    "discover_all_tools",
    "setup_tools",
]
