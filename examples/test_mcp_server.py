"""Quick test of MCP expose server."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from mcp.expose_server import AgenticMCPServer

async def test():
    server = AgenticMCPServer()
    await server.initialize()
    
    print(f"Tools loaded: {len(server._tools)}")
    print("\nAvailable tools:")
    for tool in server._tools:
        print(f"  - {tool['name']}: {tool['description'][:50]}...")
    
    # Test a tool call
    print("\n--- Testing tool call ---")
    result = await server._handle_tools_call({
        "name": "list_dir",
        "arguments": {"path": "."}
    })
    print(f"list_dir result: {result}")

if __name__ == "__main__":
    asyncio.run(test())
