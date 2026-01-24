"""
Shell execution tool - Run terminal commands.
"""

from __future__ import annotations
import asyncio
import subprocess
from typing import Any

from tools.base import Tool, ToolResult


class ShellTool(Tool):
    """
    Execute shell commands.
    
    ⚠️ DANGEROUS: This tool can execute arbitrary commands.
    User confirmation is required before execution.
    """
    
    def __init__(self, timeout: float = 30.0):
        """
        Initialize the shell tool.
        
        Args:
            timeout: Maximum execution time in seconds
        """
        self.timeout = timeout
    
    @property
    def name(self) -> str:
        return "shell"
    
    @property
    def description(self) -> str:
        return (
            "Execute a shell command and return its output. "
            "Use for running system commands, scripts, or CLI tools. "
            "Commands are executed in the current working directory."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "command": {
                "type": "string",
                "description": "The shell command to execute",
            },
            "working_dir": {
                "type": "string",
                "description": "Optional working directory for the command",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["command"]
    
    @property
    def is_dangerous(self) -> bool:
        return True
    
    async def execute(
        self,
        command: str,
        working_dir: str | None = None,
    ) -> ToolResult:
        """Execute the shell command."""
        try:
            # Run command asynchronously
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=working_dir,
            )
            
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.timeout,
                )
            except asyncio.TimeoutError:
                process.kill()
                return ToolResult.fail(
                    f"Command timed out after {self.timeout}s",
                    command=command,
                )
            
            # Decode output
            stdout_str = stdout.decode("utf-8", errors="replace").strip()
            stderr_str = stderr.decode("utf-8", errors="replace").strip()
            
            # Check return code
            if process.returncode == 0:
                output = stdout_str or "(no output)"
                return ToolResult.ok(
                    output,
                    exit_code=process.returncode,
                    stderr=stderr_str if stderr_str else None,
                )
            else:
                error_msg = stderr_str or stdout_str or "Command failed"
                return ToolResult.fail(
                    error_msg,
                    exit_code=process.returncode,
                    stdout=stdout_str,
                )
                
        except Exception as e:
            return ToolResult.fail(f"Failed to execute command: {str(e)}")


# Export the tool
TOOLS = [ShellTool()]
