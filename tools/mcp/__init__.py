"""
MCP (Model Context Protocol) tool integration.

MCP allows connecting to external tool servers that provide
additional capabilities like database access, API integrations, etc.
"""

from tools.mcp.client import MCPClient, MCPToolWrapper

__all__ = ["MCPClient", "MCPToolWrapper"]
