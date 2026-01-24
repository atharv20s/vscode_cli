"""
Filesystem tools - Read, write, and list files.
"""

from __future__ import annotations
import os
from pathlib import Path
from typing import Any

from tools.base import Tool, ToolResult


class ReadFileTool(Tool):
    """Read contents of a file."""
    
    @property
    def name(self) -> str:
        return "read_file"
    
    @property
    def description(self) -> str:
        return (
            "Read the contents of a file. "
            "Returns the file content as text. "
            "Supports optional line range for large files."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "path": {
                "type": "string",
                "description": "Path to the file to read",
            },
            "start_line": {
                "type": "integer",
                "description": "Optional starting line number (1-based)",
            },
            "end_line": {
                "type": "integer",
                "description": "Optional ending line number (1-based, inclusive)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["path"]
    
    async def execute(
        self,
        path: str,
        start_line: int | None = None,
        end_line: int | None = None,
    ) -> ToolResult:
        """Read the file contents."""
        try:
            file_path = Path(path).resolve()
            
            if not file_path.exists():
                return ToolResult.fail(f"File not found: {path}")
            
            if not file_path.is_file():
                return ToolResult.fail(f"Not a file: {path}")
            
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                if start_line or end_line:
                    lines = f.readlines()
                    start = (start_line or 1) - 1
                    end = end_line or len(lines)
                    content = "".join(lines[start:end])
                else:
                    content = f.read()
            
            return ToolResult.ok(
                content,
                path=str(file_path),
                size=len(content),
            )
            
        except PermissionError:
            return ToolResult.fail(f"Permission denied: {path}")
        except Exception as e:
            return ToolResult.fail(f"Error reading file: {str(e)}")


class WriteFileTool(Tool):
    """Write content to a file."""
    
    @property
    def name(self) -> str:
        return "write_file"
    
    @property
    def description(self) -> str:
        return (
            "Write content to a file. "
            "Creates the file if it doesn't exist. "
            "Creates parent directories if needed."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "path": {
                "type": "string",
                "description": "Path to the file to write",
            },
            "content": {
                "type": "string",
                "description": "Content to write to the file",
            },
            "append": {
                "type": "boolean",
                "description": "If true, append to existing file instead of overwriting",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["path", "content"]
    
    @property
    def is_dangerous(self) -> bool:
        return True
    
    async def execute(
        self,
        path: str,
        content: str,
        append: bool = False,
    ) -> ToolResult:
        """Write content to the file."""
        try:
            file_path = Path(path).resolve()
            
            # Create parent directories
            file_path.parent.mkdir(parents=True, exist_ok=True)
            
            mode = "a" if append else "w"
            with open(file_path, mode, encoding="utf-8") as f:
                f.write(content)
            
            action = "Appended to" if append else "Wrote"
            return ToolResult.ok(
                f"{action} {len(content)} bytes to {file_path}",
                path=str(file_path),
                bytes_written=len(content),
            )
            
        except PermissionError:
            return ToolResult.fail(f"Permission denied: {path}")
        except Exception as e:
            return ToolResult.fail(f"Error writing file: {str(e)}")


class EditFileTool(Tool):
    """
    Edit a file by replacing specific text.
    
    This tool allows surgical edits to files by finding and replacing
    exact text matches. It's safer than full file rewrites since it
    preserves surrounding content.
    """
    
    @property
    def name(self) -> str:
        return "edit_file"
    
    @property
    def description(self) -> str:
        return (
            "Edit a file by replacing specific text. "
            "Find an exact text match and replace it with new content. "
            "Use this for surgical edits instead of rewriting entire files. "
            "The old_text must match exactly (including whitespace/indentation)."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "path": {
                "type": "string",
                "description": "Path to the file to edit",
            },
            "old_text": {
                "type": "string",
                "description": "Exact text to find and replace (must match exactly)",
            },
            "new_text": {
                "type": "string",
                "description": "Text to replace with",
            },
            "all_occurrences": {
                "type": "boolean",
                "description": "If true, replace all occurrences. Default: only first match.",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["path", "old_text", "new_text"]
    
    @property
    def is_dangerous(self) -> bool:
        return True
    
    async def execute(
        self,
        path: str,
        old_text: str,
        new_text: str,
        all_occurrences: bool = False,
    ) -> ToolResult:
        """Edit the file by replacing text."""
        try:
            file_path = Path(path).resolve()
            
            if not file_path.exists():
                return ToolResult.fail(f"File not found: {path}")
            
            if not file_path.is_file():
                return ToolResult.fail(f"Not a file: {path}")
            
            # Read current content
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            
            # Check if old_text exists
            if old_text not in content:
                # Provide helpful error with context
                preview = old_text[:100] + "..." if len(old_text) > 100 else old_text
                return ToolResult.fail(
                    f"Text not found in file. Search text:\n{preview}\n\n"
                    "Tip: The text must match exactly including whitespace and indentation."
                )
            
            # Count occurrences
            count = content.count(old_text)
            
            # Perform replacement
            if all_occurrences:
                new_content = content.replace(old_text, new_text)
                replaced = count
            else:
                new_content = content.replace(old_text, new_text, 1)
                replaced = 1
            
            # Write back
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(new_content)
            
            # Calculate diff info
            lines_removed = old_text.count('\n') + 1
            lines_added = new_text.count('\n') + 1
            
            return ToolResult.ok(
                f"Edited {file_path.name}: replaced {replaced} occurrence(s)\n"
                f"Lines: -{lines_removed} +{lines_added}",
                path=str(file_path),
                occurrences_found=count,
                occurrences_replaced=replaced,
            )
            
        except PermissionError:
            return ToolResult.fail(f"Permission denied: {path}")
        except Exception as e:
            return ToolResult.fail(f"Error editing file: {str(e)}")


class ListDirTool(Tool):
    """List directory contents."""
    
    @property
    def name(self) -> str:
        return "list_dir"
    
    @property
    def description(self) -> str:
        return (
            "List the contents of a directory. "
            "Returns files and subdirectories with their types."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "path": {
                "type": "string",
                "description": "Path to the directory to list",
            },
            "recursive": {
                "type": "boolean",
                "description": "If true, list subdirectories recursively",
            },
            "pattern": {
                "type": "string",
                "description": "Optional glob pattern to filter results (e.g., '*.py')",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["path"]
    
    async def execute(
        self,
        path: str,
        recursive: bool = False,
        pattern: str | None = None,
    ) -> ToolResult:
        """List directory contents."""
        try:
            dir_path = Path(path).resolve()
            
            if not dir_path.exists():
                return ToolResult.fail(f"Directory not found: {path}")
            
            if not dir_path.is_dir():
                return ToolResult.fail(f"Not a directory: {path}")
            
            # Get entries
            if recursive:
                if pattern:
                    entries = list(dir_path.rglob(pattern))
                else:
                    entries = list(dir_path.rglob("*"))
            else:
                if pattern:
                    entries = list(dir_path.glob(pattern))
                else:
                    entries = list(dir_path.iterdir())
            
            # Format output
            lines = []
            for entry in sorted(entries):
                rel_path = entry.relative_to(dir_path)
                if entry.is_dir():
                    lines.append(f"📁 {rel_path}/")
                else:
                    size = entry.stat().st_size
                    lines.append(f"📄 {rel_path} ({size} bytes)")
            
            if not lines:
                return ToolResult.ok("(empty directory)", count=0)
            
            return ToolResult.ok(
                "\n".join(lines),
                count=len(lines),
                path=str(dir_path),
            )
            
        except PermissionError:
            return ToolResult.fail(f"Permission denied: {path}")
        except Exception as e:
            return ToolResult.fail(f"Error listing directory: {str(e)}")


# Export tools
TOOLS = [ReadFileTool(), WriteFileTool(), EditFileTool(), ListDirTool()]
