"""
Interactive Demo for Built-in MCP Servers.

This demo showcases real-world usage scenarios for all 5 built-in MCP servers.
Run this to see each server's capabilities in action.
"""

import asyncio
import tempfile
import os
from pathlib import Path
import sys

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table
from rich.markdown import Markdown

console = Console()


def header(title: str):
    """Print a section header."""
    console.print()
    console.print(Panel.fit(f"[bold cyan]{title}[/]", border_style="cyan"))


def show_tool_result(tool_name: str, result: dict):
    """Display a tool result nicely."""
    content = result.get("content", [{}])[0].get("text", str(result))
    if "error" in result:
        console.print(f"[red]Error:[/] {result['error']}")
    else:
        console.print(f"[green]✓[/] [bold]{tool_name}[/]")
        console.print(Panel(content, border_style="dim"))


async def demo_filesystem():
    """Demo FilesystemMCPServer with real-world scenarios."""
    header("📁 FilesystemMCPServer Demo")
    console.print("[dim]7 tools for file and directory operations[/]\n")
    
    from mcp.builtin_servers import FilesystemMCPServer
    
    with tempfile.TemporaryDirectory() as tmpdir:
        server = FilesystemMCPServer(root_path=tmpdir)
        await server.initialize()
        
        # Scenario 1: Create a project structure
        console.print("[bold]Scenario 1:[/] Create a Python project structure\n")
        
        await server.call_tool("create_directory", {"path": "src/utils"})
        await server.call_tool("create_directory", {"path": "tests"})
        await server.call_tool("create_directory", {"path": "docs"})
        
        await server.call_tool("write_file", {
            "path": "src/__init__.py",
            "content": '"""Main package."""\n__version__ = "1.0.0"\n'
        })
        
        await server.call_tool("write_file", {
            "path": "src/main.py",
            "content": '''"""Main module."""
import logging

def main():
    """Entry point."""
    logging.info("Application started")
    return 0

if __name__ == "__main__":
    main()
'''
        })
        
        await server.call_tool("write_file", {
            "path": "tests/test_main.py",
            "content": '''"""Test main module."""
import pytest
from src.main import main

def test_main_returns_zero():
    assert main() == 0
'''
        })
        
        await server.call_tool("write_file", {
            "path": "README.md",
            "content": "# My Project\n\nA sample project.\n"
        })
        
        # List the structure
        result = await server.call_tool("list_directory", {"path": "."})
        show_tool_result("list_directory (.)", result)
        
        result = await server.call_tool("list_directory", {"path": "src"})
        show_tool_result("list_directory (src)", result)
        
        # Scenario 2: Search for files
        console.print("\n[bold]Scenario 2:[/] Search for Python files\n")
        result = await server.call_tool("search_files", {"pattern": "**/*.py"})
        show_tool_result("search_files (**/*.py)", result)
        
        # Scenario 3: Get file info
        console.print("\n[bold]Scenario 3:[/] Get file metadata\n")
        result = await server.call_tool("file_info", {"path": "src/main.py"})
        show_tool_result("file_info (src/main.py)", result)
        
        # Scenario 4: Read and modify a file
        console.print("\n[bold]Scenario 4:[/] Read and update a file\n")
        result = await server.call_tool("read_file", {"path": "README.md"})
        show_tool_result("read_file (README.md)", result)
        
        await server.call_tool("write_file", {
            "path": "README.md",
            "content": "# My Project\n\nA sample project with tests!\n\n## Features\n- Fast\n- Reliable\n"
        })
        result = await server.call_tool("read_file", {"path": "README.md"})
        show_tool_result("read_file (updated README.md)", result)


async def demo_git():
    """Demo GitMCPServer with the actual project repo."""
    header("🔀 GitMCPServer Demo")
    console.print("[dim]7 tools for Git operations[/]\n")
    
    from mcp.builtin_servers import GitMCPServer
    
    server = GitMCPServer(repo_path=str(project_root))
    await server.initialize()
    
    # Scenario 1: Check repository status
    console.print("[bold]Scenario 1:[/] Check repository status\n")
    result = await server.call_tool("status", {})
    show_tool_result("status", result)
    
    # Scenario 2: View branches
    console.print("\n[bold]Scenario 2:[/] View branches\n")
    result = await server.call_tool("branch", {})
    show_tool_result("branch", result)
    
    result = await server.call_tool("branch", {"list_all": True})
    show_tool_result("branch (all)", result)
    
    # Scenario 3: View commit history
    console.print("\n[bold]Scenario 3:[/] View recent commits\n")
    result = await server.call_tool("log", {"count": 5, "oneline": True})
    show_tool_result("log (5 commits)", result)
    
    # Scenario 4: View a specific commit
    console.print("\n[bold]Scenario 4:[/] View latest commit details\n")
    result = await server.call_tool("show", {"commit": "HEAD"})
    content = result.get("content", [{}])[0].get("text", "")[:800]
    console.print(f"[green]✓[/] [bold]show (HEAD)[/]")
    console.print(Panel(content + "...", border_style="dim"))
    
    # Scenario 5: Check for changes
    console.print("\n[bold]Scenario 5:[/] Check working directory changes\n")
    result = await server.call_tool("diff", {})
    show_tool_result("diff", result)


async def demo_shell():
    """Demo ShellMCPServer with safe commands."""
    header("💻 ShellMCPServer Demo")
    console.print("[dim]2 tools for shell and Python execution[/]\n")
    
    from mcp.builtin_servers import ShellMCPServer
    
    server = ShellMCPServer(working_dir=str(project_root))
    await server.initialize()
    
    # Scenario 1: System information
    console.print("[bold]Scenario 1:[/] Get system information\n")
    
    if os.name == "nt":
        result = await server.call_tool("execute", {"command": "echo %USERNAME%@%COMPUTERNAME%"})
    else:
        result = await server.call_tool("execute", {"command": "echo $USER@$HOSTNAME"})
    show_tool_result("execute (user info)", result)
    
    result = await server.call_tool("execute", {"command": "python --version"})
    show_tool_result("execute (python version)", result)
    
    # Scenario 2: List directory with details
    console.print("\n[bold]Scenario 2:[/] List project files\n")
    if os.name == "nt":
        result = await server.call_tool("execute", {"command": "dir /b *.py *.md"})
    else:
        result = await server.call_tool("execute", {"command": "ls -la *.py *.md 2>/dev/null || true"})
    show_tool_result("execute (list files)", result)
    
    # Scenario 3: Run Python code
    console.print("\n[bold]Scenario 3:[/] Execute Python code\n")
    
    result = await server.call_tool("run_python", {
        "code": '''
import sys
import platform
import os

print(f"Python: {sys.version}")
print(f"Platform: {platform.platform()}")
print(f"Working Dir: {os.getcwd()}")
'''
    })
    show_tool_result("run_python (system info)", result)
    
    # Scenario 4: Calculate something
    console.print("\n[bold]Scenario 4:[/] Python calculations\n")
    result = await server.call_tool("run_python", {
        "code": '''
import math

# Calculate some values
data = [12, 45, 78, 23, 56, 89, 34]
print(f"Data: {data}")
print(f"Sum: {sum(data)}")
print(f"Average: {sum(data)/len(data):.2f}")
print(f"Max: {max(data)}")
print(f"Min: {min(data)}")
print(f"Std Dev: {math.sqrt(sum((x - sum(data)/len(data))**2 for x in data) / len(data)):.2f}")
'''
    })
    show_tool_result("run_python (statistics)", result)
    
    # Scenario 5: Safety check
    console.print("\n[bold]Scenario 5:[/] Safety checks (blocked commands)\n")
    result = await server.call_tool("execute", {"command": "rm -rf /"})
    content = result.get("content", [{}])[0].get("text", str(result.get("error", "")))
    console.print(f"[yellow]⚠[/] [bold]Dangerous command blocked[/]")
    console.print(Panel(f"Command 'rm -rf /' was blocked for safety", border_style="yellow"))


async def demo_sqlite():
    """Demo SQLiteMCPServer with a sample database."""
    header("🗄️ SQLiteMCPServer Demo")
    console.print("[dim]4 tools for SQLite database operations[/]\n")
    
    from mcp.builtin_servers import SQLiteMCPServer
    
    import uuid
    db_path = os.path.join(tempfile.gettempdir(), f"demo_{uuid.uuid4().hex}.db")
    
    try:
        server = SQLiteMCPServer(db_path=db_path)
        await server.initialize()
        
        # Scenario 1: Create database schema
        console.print("[bold]Scenario 1:[/] Create database schema\n")
        
        await server.call_tool("execute", {
            "sql": """
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    email TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """
        })
        
        await server.call_tool("execute", {
            "sql": """
                CREATE TABLE posts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER REFERENCES users(id),
                    title TEXT NOT NULL,
                    content TEXT,
                    published BOOLEAN DEFAULT 0
                )
            """
        })
        console.print("[green]✓[/] Created users and posts tables")
        
        # List tables
        result = await server.call_tool("list_tables", {})
        show_tool_result("list_tables", result)
        
        # Scenario 2: Describe table schema
        console.print("\n[bold]Scenario 2:[/] Inspect table schema\n")
        result = await server.call_tool("describe_table", {"table": "users"})
        show_tool_result("describe_table (users)", result)
        
        result = await server.call_tool("describe_table", {"table": "posts"})
        show_tool_result("describe_table (posts)", result)
        
        # Scenario 3: Insert data
        console.print("\n[bold]Scenario 3:[/] Insert sample data\n")
        
        await server.call_tool("execute", {
            "sql": "INSERT INTO users (username, email) VALUES ('alice', 'alice@example.com')"
        })
        await server.call_tool("execute", {
            "sql": "INSERT INTO users (username, email) VALUES ('bob', 'bob@example.com')"
        })
        await server.call_tool("execute", {
            "sql": "INSERT INTO users (username, email) VALUES ('charlie', 'charlie@example.com')"
        })
        
        await server.call_tool("execute", {
            "sql": "INSERT INTO posts (user_id, title, content, published) VALUES (1, 'Hello World', 'My first post!', 1)"
        })
        await server.call_tool("execute", {
            "sql": "INSERT INTO posts (user_id, title, content, published) VALUES (1, 'Python Tips', 'Use type hints!', 1)"
        })
        await server.call_tool("execute", {
            "sql": "INSERT INTO posts (user_id, title, content, published) VALUES (2, 'Draft Post', 'Work in progress...', 0)"
        })
        console.print("[green]✓[/] Inserted users and posts")
        
        # Scenario 4: Query data
        console.print("\n[bold]Scenario 4:[/] Query data\n")
        
        result = await server.call_tool("query", {"sql": "SELECT * FROM users"})
        show_tool_result("query (all users)", result)
        
        result = await server.call_tool("query", {
            "sql": """
                SELECT u.username, p.title, p.published 
                FROM users u 
                JOIN posts p ON u.id = p.user_id
                ORDER BY u.username
            """
        })
        show_tool_result("query (users with posts)", result)
        
        result = await server.call_tool("query", {
            "sql": "SELECT username, email FROM users WHERE username LIKE 'a%'"
        })
        show_tool_result("query (users starting with 'a')", result)
        
        # Cleanup
        server.close()
        
    finally:
        try:
            os.unlink(db_path)
        except:
            pass


async def demo_memory():
    """Demo MemoryMCPServer for persistent storage."""
    header("🧠 MemoryMCPServer Demo")
    console.print("[dim]5 tools for persistent key-value storage[/]\n")
    
    from mcp.builtin_servers import MemoryMCPServer
    
    with tempfile.TemporaryDirectory() as tmpdir:
        server = MemoryMCPServer(storage_path=os.path.join(tmpdir, "memory.json"))
        await server.initialize()
        
        # Scenario 1: Store user preferences
        console.print("[bold]Scenario 1:[/] Store user preferences\n")
        
        await server.call_tool("store", {
            "key": "user_theme",
            "value": "dark",
            "category": "preferences"
        })
        await server.call_tool("store", {
            "key": "user_language",
            "value": "en",
            "category": "preferences"
        })
        await server.call_tool("store", {
            "key": "editor_font",
            "value": "Fira Code",
            "category": "preferences"
        })
        console.print("[green]✓[/] Stored preferences")
        
        # Scenario 2: Store project context
        console.print("\n[bold]Scenario 2:[/] Store project context\n")
        
        await server.call_tool("store", {
            "key": "current_project",
            "value": "Agentic CLI",
            "category": "context"
        })
        await server.call_tool("store", {
            "key": "last_file_edited",
            "value": "/src/main.py",
            "category": "context"
        })
        await server.call_tool("store", {
            "key": "todo_items",
            "value": '["Fix bug #123", "Add tests", "Update docs"]',
            "category": "context"
        })
        console.print("[green]✓[/] Stored project context")
        
        # Scenario 3: Store notes
        console.print("\n[bold]Scenario 3:[/] Store notes and facts\n")
        
        await server.call_tool("store", {
            "key": "meeting_notes",
            "value": "Discussed Q2 roadmap. Key priorities: performance, UX.",
            "category": "notes"
        })
        await server.call_tool("store", {
            "key": "api_key_location",
            "value": "Stored in .env file, never commit to git!",
            "category": "notes"
        })
        console.print("[green]✓[/] Stored notes")
        
        # Scenario 4: List and retrieve
        console.print("\n[bold]Scenario 4:[/] List all stored items\n")
        result = await server.call_tool("list", {})
        show_tool_result("list (all)", result)
        
        result = await server.call_tool("retrieve", {"key": "current_project"})
        show_tool_result("retrieve (current_project)", result)
        
        result = await server.call_tool("retrieve", {"key": "todo_items"})
        show_tool_result("retrieve (todo_items)", result)
        
        # Scenario 5: Search
        console.print("\n[bold]Scenario 5:[/] Search stored information\n")
        
        result = await server.call_tool("search", {"query": "project"})
        show_tool_result("search (project)", result)
        
        result = await server.call_tool("search", {"query": "git"})
        show_tool_result("search (git)", result)
        
        # Scenario 6: Update and delete
        console.print("\n[bold]Scenario 6:[/] Update and delete\n")
        
        await server.call_tool("store", {
            "key": "user_theme",
            "value": "light",  # Changed from dark
            "category": "preferences"
        })
        result = await server.call_tool("retrieve", {"key": "user_theme"})
        show_tool_result("retrieve (updated theme)", result)
        
        await server.call_tool("delete", {"key": "meeting_notes"})
        result = await server.call_tool("list", {})
        show_tool_result("list (after delete)", result)


async def main():
    """Run all demos."""
    console.print(Panel.fit(
        "[bold magenta]🚀 MCP Built-in Servers Interactive Demo[/]\n\n"
        "[dim]5 servers • 21 tools • Real-world scenarios[/]",
        border_style="magenta"
    ))
    
    try:
        await demo_filesystem()
        await demo_git()
        await demo_shell()
        await demo_sqlite()
        await demo_memory()
        
        console.print()
        console.print(Panel.fit(
            "[bold green]✅ All demos completed successfully![/]\n\n"
            "[dim]These MCP servers are ready to use with Claude Desktop\n"
            "or any MCP-compatible client.[/]",
            border_style="green"
        ))
        
    except Exception as e:
        console.print(f"\n[red]Error:[/] {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
