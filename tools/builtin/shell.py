"""
Shell execution tool - Run terminal commands locally or on a remote Oracle Cloud (OCI) Sandbox.
"""

from __future__ import annotations
import asyncio
import os
import shlex
import subprocess
from pathlib import Path
from typing import Any

from tools.base import Tool, ToolResult
from config.config import get_config


class ShellTool(Tool):
    """
    Execute shell commands.
    
    Supports:
    1. Local execution (PowerShell / Bash / CMD).
    2. Remote Cloud execution (Oracle Cloud Infrastructure / SSH / Docker Sandbox).
    """
    
    def __init__(self, timeout: float = 60.0):
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
        cfg = get_config()
        if cfg.remote_enabled and cfg.remote_host:
            return (
                f"Execute a command inside the remote Oracle Cloud Sandbox (host: {cfg.remote_host}, user: {cfg.remote_user}). "
                "Commands run isolated in the cloud workspace."
            )
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
                "description": "Optional working directory for the command (relative or absolute)",
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
        """Execute the shell command (locally or in remote OCI sandbox)."""
        cfg = get_config()
        
        if cfg.remote_enabled and cfg.remote_host:
            return await self._execute_remote(command, working_dir, cfg)
        else:
            return await self._execute_local(command, working_dir)
    
    async def _execute_remote(
        self,
        command: str,
        working_dir: str | None,
        cfg: Any,
    ) -> ToolResult:
        """Execute command inside the remote Oracle Cloud VM / Docker sandbox over SSH."""
        try:
            # 1. Resolve remote directory
            remote_base = cfg.remote_workspace.rstrip("/")
            if working_dir:
                clean_wd = working_dir.replace("\\", "/").strip("/")
                if clean_wd.startswith("/"):
                    remote_cwd = clean_wd
                else:
                    remote_cwd = f"{remote_base}/{clean_wd}"
            else:
                remote_cwd = remote_base

            # 2. Build remote command string
            # Ensure remote workspace exists before executing
            if cfg.remote_docker_container:
                # Execute inside a specific Docker container on the OCI VM
                escaped_cmd = command.replace('"', '\\"').replace('$', '\\$')
                remote_payload = (
                    f"docker exec -i {cfg.remote_docker_container} "
                    f"bash -c \"mkdir -p '{remote_cwd}' && cd '{remote_cwd}' && {escaped_cmd}\""
                )
            else:
                # Execute natively on the OCI Linux host
                remote_payload = f"mkdir -p '{remote_cwd}' && cd '{remote_cwd}' && {command}"

            # 3. Construct SSH argument list
            ssh_args = [
                "ssh",
                "-p", str(cfg.remote_port),
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "LogLevel=ERROR",
                "-o", "ConnectTimeout=10",
                "-o", "BatchMode=yes",
            ]

            if cfg.remote_key_path:
                key_path = os.path.expanduser(cfg.remote_key_path)
                if not os.path.isabs(key_path):
                    key_path = os.path.abspath(key_path)
                ssh_args.extend(["-i", key_path])

            target = f"{cfg.remote_user}@{cfg.remote_host}"
            ssh_args.append(target)
            ssh_args.append(remote_payload)

            # 4. Run SSH subprocess
            process = await asyncio.create_subprocess_exec(
                *ssh_args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.timeout,
                )
            except asyncio.TimeoutError:
                try:
                    process.kill()
                except Exception:
                    pass
                return ToolResult.fail(
                    f"Remote command timed out after {self.timeout}s on OCI VM ({cfg.remote_host})",
                    command=command,
                )

            stdout_str = stdout.decode("utf-8", errors="replace").strip()
            stderr_str = stderr.decode("utf-8", errors="replace").strip()

            if process.returncode == 0:
                output = stdout_str or "(no output - command completed successfully)"
                return ToolResult.ok(
                    output,
                    exit_code=0,
                    remote=True,
                    host=cfg.remote_host,
                    remote_cwd=remote_cwd,
                    stderr=stderr_str if stderr_str else None,
                )
            else:
                error_msg = stderr_str or stdout_str or f"Command exited with code {process.returncode}"
                return ToolResult.fail(
                    error_msg,
                    exit_code=process.returncode,
                    remote=True,
                    host=cfg.remote_host,
                    stdout=stdout_str if stdout_str else None,
                )

        except Exception as e:
            return ToolResult.fail(
                f"Failed to execute command on Oracle Cloud VM ({cfg.remote_host}): {str(e)}"
            )

    async def _execute_local(
        self,
        command: str,
        working_dir: str | None,
    ) -> ToolResult:
        """Execute command locally on current machine."""
        try:
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
                try:
                    process.kill()
                except Exception:
                    pass
                return ToolResult.fail(
                    f"Command timed out after {self.timeout}s",
                    command=command,
                )
            
            stdout_str = stdout.decode("utf-8", errors="replace").strip()
            stderr_str = stderr.decode("utf-8", errors="replace").strip()
            
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
