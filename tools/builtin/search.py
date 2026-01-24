"""
Search tools - Grep (text search) and Glob (file pattern matching).

Grep vs Glob:
- GREP: Search for text INSIDE files (content search)
- GLOB: Search for files by NAME pattern (filename matching)
"""

from __future__ import annotations
import os
import re
from pathlib import Path
from typing import Any

from tools.base import Tool, ToolResult


class GrepTool(Tool):
    """
    Search for text patterns inside files.
    
    Use this when you want to find files containing specific text,
    code patterns, function names, variable references, etc.
    
    Example: Find all files containing "def main"
    """
    
    @property
    def name(self) -> str:
        return "grep"
    
    @property
    def description(self) -> str:
        return (
            "Search for text patterns inside files (like Unix grep). "
            "Finds files containing the specified text or regex pattern. "
            "Use this to find code, function definitions, variable usage, etc."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "pattern": {
                "type": "string",
                "description": "Text or regex pattern to search for",
            },
            "path": {
                "type": "string",
                "description": "Directory to search in (default: current directory)",
            },
            "file_pattern": {
                "type": "string",
                "description": "Glob pattern to filter files (e.g., '*.py', '*.js')",
            },
            "regex": {
                "type": "boolean",
                "description": "Treat pattern as regex (default: false, plain text)",
            },
            "ignore_case": {
                "type": "boolean",
                "description": "Case-insensitive search (default: false)",
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of matches to return (default: 50)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["pattern"]
    
    async def execute(
        self,
        pattern: str,
        path: str = ".",
        file_pattern: str = "*",
        regex: bool = False,
        ignore_case: bool = False,
        max_results: int = 50,
    ) -> ToolResult:
        """Search for pattern inside files."""
        try:
            search_path = Path(path).resolve()
            
            if not search_path.exists():
                return ToolResult.fail(f"Path not found: {path}")
            
            # Compile pattern
            flags = re.IGNORECASE if ignore_case else 0
            if regex:
                try:
                    compiled = re.compile(pattern, flags)
                except re.error as e:
                    return ToolResult.fail(f"Invalid regex: {e}")
            else:
                # Escape for literal matching
                escaped = re.escape(pattern)
                compiled = re.compile(escaped, flags)
            
            matches = []
            files_searched = 0
            
            # Search files
            if search_path.is_file():
                files = [search_path]
            else:
                files = list(search_path.rglob(file_pattern))
            
            for file_path in files:
                if not file_path.is_file():
                    continue
                
                # Skip binary and large files
                try:
                    if file_path.stat().st_size > 1_000_000:  # 1MB limit
                        continue
                except OSError:
                    continue
                
                files_searched += 1
                
                try:
                    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                        for line_num, line in enumerate(f, 1):
                            if compiled.search(line):
                                rel_path = file_path.relative_to(search_path) if search_path.is_dir() else file_path.name
                                matches.append({
                                    "file": str(rel_path),
                                    "line": line_num,
                                    "content": line.rstrip()[:200],  # Truncate long lines
                                })
                                
                                if len(matches) >= max_results:
                                    break
                except (PermissionError, OSError):
                    continue
                
                if len(matches) >= max_results:
                    break
            
            if not matches:
                return ToolResult.ok(
                    f"No matches found for '{pattern}' in {files_searched} files",
                    pattern=pattern,
                    count=0,
                    files_searched=files_searched,
                )
            
            # Format output
            output_lines = [f"🔍 Found {len(matches)} matches for '{pattern}':\n"]
            
            current_file = None
            for m in matches:
                if m["file"] != current_file:
                    current_file = m["file"]
                    output_lines.append(f"\n📄 {current_file}")
                output_lines.append(f"  L{m['line']:4d}: {m['content']}")
            
            if len(matches) >= max_results:
                output_lines.append(f"\n... (limited to {max_results} results)")
            
            return ToolResult.ok(
                "\n".join(output_lines),
                pattern=pattern,
                count=len(matches),
                files_searched=files_searched,
            )
            
        except Exception as e:
            return ToolResult.fail(f"Grep failed: {str(e)}")


class GlobTool(Tool):
    """
    Find files by name pattern.
    
    Use this when you want to find files matching a name pattern,
    list all Python files, find config files, etc.
    
    Example: Find all "*.py" files, find "*config*" files
    """
    
    @property
    def name(self) -> str:
        return "glob"
    
    @property
    def description(self) -> str:
        return (
            "Find files by name pattern (like Unix find/glob). "
            "Matches filenames against a glob pattern. "
            "Use this to find files by extension, name pattern, etc. "
            "Examples: '*.py' for Python files, '*config*' for config files."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "pattern": {
                "type": "string",
                "description": "Glob pattern to match (e.g., '*.py', '*test*.js', '**/*.md')",
            },
            "path": {
                "type": "string",
                "description": "Directory to search in (default: current directory)",
            },
            "recursive": {
                "type": "boolean",
                "description": "Search subdirectories recursively (default: true)",
            },
            "include_hidden": {
                "type": "boolean",
                "description": "Include hidden files/directories (default: false)",
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of files to return (default: 100)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["pattern"]
    
    async def execute(
        self,
        pattern: str,
        path: str = ".",
        recursive: bool = True,
        include_hidden: bool = False,
        max_results: int = 100,
    ) -> ToolResult:
        """Find files matching the glob pattern."""
        try:
            search_path = Path(path).resolve()
            
            if not search_path.exists():
                return ToolResult.fail(f"Path not found: {path}")
            
            if not search_path.is_dir():
                return ToolResult.fail(f"Not a directory: {path}")
            
            # Find matching files
            if recursive:
                # Make pattern recursive if not already
                if not pattern.startswith("**/"):
                    search_pattern = f"**/{pattern}"
                else:
                    search_pattern = pattern
                matches = list(search_path.glob(search_pattern))
            else:
                matches = list(search_path.glob(pattern))
            
            # Filter hidden files if needed
            if not include_hidden:
                matches = [
                    m for m in matches
                    if not any(part.startswith(".") for part in m.parts)
                ]
            
            # Sort and limit
            matches = sorted(matches)[:max_results]
            
            if not matches:
                return ToolResult.ok(
                    f"No files found matching '{pattern}'",
                    pattern=pattern,
                    count=0,
                )
            
            # Format output
            output_lines = [f"📂 Found {len(matches)} files matching '{pattern}':\n"]
            
            for match in matches:
                rel_path = match.relative_to(search_path)
                if match.is_dir():
                    output_lines.append(f"  📁 {rel_path}/")
                else:
                    try:
                        size = match.stat().st_size
                        size_str = _format_size(size)
                        output_lines.append(f"  📄 {rel_path} ({size_str})")
                    except OSError:
                        output_lines.append(f"  📄 {rel_path}")
            
            if len(matches) >= max_results:
                output_lines.append(f"\n... (limited to {max_results} results)")
            
            return ToolResult.ok(
                "\n".join(output_lines),
                pattern=pattern,
                count=len(matches),
            )
            
        except Exception as e:
            return ToolResult.fail(f"Glob failed: {str(e)}")


def _format_size(size: int) -> str:
    """Format file size in human-readable form."""
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.1f}{unit}" if unit != "B" else f"{size}{unit}"
        size /= 1024
    return f"{size:.1f}TB"


# Export tools
TOOLS = [GrepTool(), GlobTool()]
