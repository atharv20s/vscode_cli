"""
MCP Demo - Demonstrates the Model Context Protocol implementation.

Shows:
1. Built-in MCP servers (filesystem, git, shell, memory)
2. MCP Host managing multiple servers
3. Tool discovery and execution
4. Configuration for Claude Desktop
"""

from __future__ import annotations
import asyncio
from pathlib import Path
import sys

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))


def print_header(title: str) -> None:
    """Print a formatted header."""
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}\n")


def print_section(title: str) -> None:
    """Print a section header."""
    print(f"\n--- {title} ---\n")


async def demo_builtin_servers() -> None:
    """Demo the built-in MCP servers."""
    from mcp.builtin_servers import MCPServerRegistry
    
    print_header("BUILT-IN MCP SERVERS")
    
    # List available server types
    available = MCPServerRegistry.list_available()
    print(f"Available server types: {', '.join(available)}")
    
    # Create and test filesystem server
    print_section("Filesystem Server")
    fs_server = await MCPServerRegistry.create_and_initialize(
        "filesystem", 
        root_path=str(project_root)
    )
    
    fs_tools = fs_server.list_tools()
    print(f"Filesystem tools ({len(fs_tools)}):")
    for tool in fs_tools:
        print(f"  • {tool['name']}: {tool['description'][:50]}...")
    
    # Test reading a file
    print("\nTesting read_file:")
    result = await fs_server.call_tool("read_file", {"path": "README.md"})
    content = result.get("content", [{}])[0].get("text", "")
    preview = content[:200] + "..." if len(content) > 200 else content
    print(f"  Result: {preview}")
    
    # Create and test git server
    print_section("Git Server")
    git_server = await MCPServerRegistry.create_and_initialize(
        "git",
        repo_path=str(project_root)
    )
    
    git_tools = git_server.list_tools()
    print(f"Git tools ({len(git_tools)}):")
    for tool in git_tools:
        print(f"  • {tool['name']}: {tool['description'][:50]}...")
    
    # Test git status
    print("\nTesting status:")
    result = await git_server.call_tool("status", {})
    content = result.get("content", [{}])[0].get("text", "")
    print(f"  Result:\n{content[:300]}...")
    
    # Create and test memory server
    print_section("Memory Server")
    mem_server = await MCPServerRegistry.create_and_initialize("memory")
    
    mem_tools = mem_server.list_tools()
    print(f"Memory tools ({len(mem_tools)}):")
    for tool in mem_tools:
        print(f"  • {tool['name']}: {tool['description'][:50]}...")
    
    # Test memory operations
    print("\nTesting memory store/retrieve:")
    await mem_server.call_tool("store", {
        "key": "demo_key",
        "value": "Hello from MCP demo!",
    })
    result = await mem_server.call_tool("retrieve", {"key": "demo_key"})
    print(f"  Stored and retrieved: {result}")


async def demo_mcp_host() -> None:
    """Demo the MCP Host managing multiple servers."""
    from mcp.host import MCPHost
    
    print_header("MCP HOST")
    
    host = MCPHost()
    
    # Add multiple servers
    print("Adding servers...")
    await host.add_builtin_server("filesystem", root_path=str(project_root))
    await host.add_builtin_server("git", repo_path=str(project_root))
    await host.add_builtin_server("memory")
    await host.add_builtin_server("shell", working_dir=str(project_root))
    
    # List connected servers
    servers = host.list_servers()
    print(f"\nConnected servers ({len(servers)}):")
    for server in servers:
        print(f"  • {server.name}: {server.server_type} ({server.tools_count} tools)")
    
    # Get all tools
    all_tools = host.get_all_tools()
    print(f"\nTotal tools available: {len(all_tools)}")
    
    # Show some tools
    print("\nSample tools:")
    for tool in all_tools[:10]:
        func = tool.get("function", {})
        print(f"  • {func.get('name')}")
    print(f"  ... and {len(all_tools) - 10} more")
    
    # Call a tool via the host
    print_section("Tool Execution via Host")
    
    # Read a file
    print("Calling filesystem_read_file:")
    result = await host.call_tool("filesystem_read_file", {"path": "README.md"})
    content = result.get("content", [{}])[0].get("text", "")
    print(f"  Success: {len(content)} characters read")
    
    # Store in memory
    print("\nCalling memory_store:")
    result = await host.call_tool("memory_store", {
        "key": "host_test",
        "value": {"message": "Stored via MCP Host!"}
    })
    print(f"  Result: {result}")
    
    # Get stats
    print_section("Host Statistics")
    stats = host.get_stats()
    for key, value in stats.items():
        print(f"  {key}: {value}")
    
    # Cleanup
    await host.shutdown()


def demo_config_generation() -> None:
    """Demo the configuration generator."""
    from mcp.config_manager import (
        MCPConfigManager, 
        get_agentic_config, 
        generate_claude_config,
        COMMON_MCP_SERVERS,
    )
    
    print_header("CONFIGURATION GENERATOR")
    
    # Get Agentic CLI config
    agentic_config = get_agentic_config(project_root)
    print("Agentic CLI MCP Server Config:")
    print(f"  Name: {agentic_config.name}")
    print(f"  Command: {agentic_config.command}")
    print(f"  Args: {agentic_config.args}")
    
    # Generate Claude Desktop config
    print_section("Claude Desktop Config")
    config_json = generate_claude_config(project_root)
    print(config_json)
    
    # Show available common servers
    print_section("Available Pre-configured Servers")
    for name, server in COMMON_MCP_SERVERS.items():
        print(f"  • {name}: {server.description}")
    
    # Config manager
    print_section("Config Manager")
    manager = MCPConfigManager()
    manager.add_server(agentic_config)
    
    print(f"Config path: {manager.config_path}")
    print(f"Servers added: {len(manager.list_servers())}")


def demo_tool_discovery() -> None:
    """Demo tool discovery from all sources."""
    print_header("TOOL DISCOVERY")
    
    try:
        from tools.builtin import (
            ShellTool, ReadFileTool, WriteFileTool, EditFileTool, ListDirTool,
            WebSearchTool, FetchURLTool, GrepTool, GlobTool,
            AnalyzeCodeTool, RunPythonTool, RunPythonFileTool, LintCodeTool,
            FindDefinitionTool, FindUsagesTool, RunTestsTool,
            GitStatusTool, GitDiffTool, GitLogTool, GitCommitTool,
            GitBranchTool, GitCheckoutTool,
            RememberTool, RecallTool, ListMemoriesTool, ForgetTool, SummarizeSessionTool,
        )
        
        # Group tools by category
        tool_groups = {
            "Filesystem": [ShellTool, ReadFileTool, WriteFileTool, EditFileTool, ListDirTool],
            "Web": [WebSearchTool, FetchURLTool],
            "Search": [GrepTool, GlobTool],
            "Code Intelligence": [
                AnalyzeCodeTool, RunPythonTool, RunPythonFileTool, LintCodeTool,
                FindDefinitionTool, FindUsagesTool, RunTestsTool,
            ],
            "Git": [GitStatusTool, GitDiffTool, GitLogTool, GitCommitTool, GitBranchTool, GitCheckoutTool],
            "Memory": [RememberTool, RecallTool, ListMemoriesTool, ForgetTool, SummarizeSessionTool],
        }
        
        total = 0
        for category, tool_classes in tool_groups.items():
            print(f"\n{category} Tools ({len(tool_classes)}):")
            for tool_class in tool_classes:
                try:
                    tool = tool_class()
                    print(f"  * {tool.name}")
                except:
                    print(f"  * {tool_class.__name__}")
            total += len(tool_classes)
        
        print(f"\n{'='*40}")
        print(f"Total tools available: {total}")
        print(f"These tools are exposed via MCP to Claude Desktop!")
        
    except ImportError as e:
        print(f"Could not import tools: {e}")


async def main() -> None:
    """Run all demos."""
    print("\n" + "+" + "="*68 + "+")
    print("|" + " "*20 + "MCP DEMONSTRATION" + " "*31 + "|")
    print("|" + " "*15 + "Model Context Protocol in Action" + " "*20 + "|")
    print("+" + "="*68 + "+")
    
    try:
        # Demo built-in servers
        await demo_builtin_servers()
        
        # Demo MCP Host
        await demo_mcp_host()
        
        # Demo config generation
        demo_config_generation()
        
        # Demo tool discovery
        demo_tool_discovery()
        
        # Summary
        print_header("SUMMARY")
        print("""
MCP Implementation Features:
  ✓ Built-in Python MCP servers (no Node.js required!)
  ✓ MCP Host for managing multiple servers
  ✓ Tool aggregation from all sources
  ✓ Claude Desktop integration via expose_server.py
  ✓ Configuration generator for easy setup
  
To connect Claude Desktop to Agentic CLI:
  1. Run: python mcp/config_manager.py
  2. Follow the instructions to update claude_desktop_config.json
  3. Restart Claude Desktop
  4. Start using your 60+ tools in Claude!
""")
        
    except Exception as e:
        print(f"\n❌ Error during demo: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    asyncio.run(main())
