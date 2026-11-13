"""
Shell execution tool - Run terminal commands locally or on a remote Oracle Cloud (OCI) Sandbox.
"""

from __future__ import annotations
import asyncio
import os
import shlex
import subprocess
import posixpath
import re
from pathlib import Path

from safety.command_safety import ApprovalPolicy, SafetyConfig, SafetyManager, PathSafetyChecker
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
    
    def __init__(
        self,
        timeout: float = 60.0,
        safety_manager: SafetyManager | None = None,
        approval_callback=None,
    ):
        self.timeout = timeout
        self.safety_manager = safety_manager or SafetyManager(
            SafetyConfig(approval_policy=ApprovalPolicy.ON_REQUEST)
        )
        if approval_callback:
            self.safety_manager.set_approval_callback(approval_callback)

    def set_approval_callback(self, callback) -> None:
        """Install the host application's explicit approval callback."""
        self.safety_manager.set_approval_callback(callback)

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
        """Run only read-only allowlisted commands or explicitly approved work."""
        cfg = get_config()
        safety = await self.safety_manager.check_and_approve_command(command)
        if not safety.allowed:
            explanation = safety.message or "Command blocked by safety policy."
            if safety.r    async def _execute_remote(
        self,
        command: str,
        working_dir: str | None,
        cfg: Any,
    ) -> ToolResult:
        """Execute an approved command over SSH with pinned host-key checking."""
        try:
            remote_root = posixpath.normpath(str(cfg.remote_workspace or ""))
            if not remote_root.startswith("/"):
                return ToolResult.fail("Remote workspace must be an absolute POSIX path.")
            candidate = (
                posixpath.normpath(working_dir)
                if working_dir and posixpath.isabs(working_dir)
                else posixpath.normpath(posixpath.join(remote_root, working_dir or "."))
            )
            if posixpath.commonpath([remote_root, candidate]) != remote_root:
                return ToolResult.fail("Remote working directory is outside the configured sandbox root.")

            # Docker container names are identifiers, not arbitrary shell fragments.
            container = str(cfg.remote_docker_container or "")
            if container and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", container):
                return ToolResult.fail("Invalid remote Docker container name.")

            quoted_cwd = shlex.quote(candidate)
            inner = f"mkdir -p -- {quoted_cwd} && cd -- {quoted_cwd} && {command}"
            if container:
                remote_payload = (
                    f"docker exec -i -- {shlex.quote(container)} "
                    f"bash -lc {shlex.quote(inner)}"
                )
            else:
                remote_payload = inner

            ssh_args = [
                "ssh",
                "-p", str(cfg.remote_port),
                "-o", "StrictHostKeyChecking=yes",
                "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=10",
                "-o", "LogLevel=ERROR",
            ]
            if cfg.remote_key_path:
                key_path = os.path.expanduser(cfg.remote_key_path)
                if not os.path.isabs(key_path):
                    key_path = os.path.abspath(key_path)
                ssh_args.extend(["-i", key_path])

            ssh_args.extend([f"{cfg.remote_user}@{cfg.remote_host}", remote_payload])
            process = await asyncio.create_subprocess_exec(
                *ssh_args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=self.timeout)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
                return ToolResult.fail(
                    f"Remote command timed out after {self.timeout}s on {cfg.remote_host}",
                    command=command,
                )

            stdout_str = stdout.decode("utf-8", errors="replace").strip()
            stderr_str = stderr.decode("utf-8", errors="replace").strip()
            if process.returncode == 0:
                return ToolResult.ok(
                    stdout_str or "(no output - command completed successfully)",
                    exit_code=0,
                    remote=True,
                    host=cfg.remote_host,
                    remote_cwd=candidate,
                    stderr=stderr_str or None,
                )
            return ToolResult.fail(
                stderr_str or stdout_str or f"Command exited with code {process.returncode}",
                exit_code=process.returncode,
                remote=True,
                host=cfg.remote_host,
            )
        except Exception as error:
            return ToolResult.fail(f"Remote command failed: {error}")

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
