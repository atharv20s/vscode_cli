"""
Git Tools - Version control integration.

Gap Addressed: LLMs have no git awareness.
These tools let the agent check status, view diffs, and commit changes.
"""

from __future__ import annotations
import asyncio
from typing import Any
from pathlib import Path

from tools.base import Tool, ToolResult


class GitStatusTool(Tool):
    """Get current git repository status."""
    
    @property
    def name(self) -> str:
        return "git_status"
    
    @property
    def description(self) -> str:
        return (
            "Get git status showing changed, staged, and untracked files. "
            "Use before committing or to see what's been modified."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {}
    
    @property
    def required_params(self) -> list[str]:
        return []
    
    async def execute(self) -> ToolResult:
        """Get git status."""
        try:
            process = await asyncio.create_subprocess_exec(
                "git", "status", "--short", "--branch",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                error = stderr.decode() if stderr else "Unknown error"
                return ToolResult.fail(f"Git error: {error}")
            
            output = stdout.decode() if stdout else ""
            
            if not output.strip() or output.strip().startswith("##"):
                # Only branch info, no changes
                branch = output.strip().replace("## ", "").split("...")[0] if output else "unknown"
                return ToolResult.ok(f"✅ **Branch: {branch}**\n\nWorking tree clean - no changes")
            
            # Parse the output
            lines = output.strip().split("\n")
            branch_line = lines[0] if lines[0].startswith("##") else ""
            changes = lines[1:] if branch_line else lines
            
            branch = branch_line.replace("## ", "").split("...")[0] if branch_line else "unknown"
            
            result = f"📋 **Git Status** (Branch: `{branch}`)\n\n"
            
            staged = []
            modified = []
            untracked = []
            
            for line in changes:
                if not line.strip():
                    continue
                status = line[:2]
                filename = line[3:]
                
                if status[0] in "MADRCU":
                    staged.append(f"  - `{filename}`")
                if status[1] == "M":
                    modified.append(f"  - `{filename}`")
                elif status == "??":
                    untracked.append(f"  - `{filename}`")
            
            if staged:
                result += f"**Staged ({len(staged)}):**\n" + "\n".join(staged[:10]) + "\n\n"
            if modified:
                result += f"**Modified ({len(modified)}):**\n" + "\n".join(modified[:10]) + "\n\n"
            if untracked:
                result += f"**Untracked ({len(untracked)}):**\n" + "\n".join(untracked[:10]) + "\n"
            
            return ToolResult.ok(result)
            
        except FileNotFoundError:
            return ToolResult.fail("Git not found. Is git installed?")
        except Exception as e:
            return ToolResult.fail(f"Git failed: {e}")


class GitDiffTool(Tool):
    """Get diff of current changes."""
    
    @property
    def name(self) -> str:
        return "git_diff"
    
    @property
    def description(self) -> str:
        return (
            "Show git diff of uncommitted changes. "
            "Can diff specific file or show staged changes."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "file": {
                "type": "string", 
                "description": "Specific file to diff (optional)",
            },
            "staged": {
                "type": "boolean",
                "description": "Show staged changes instead of unstaged",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return []
    
    async def execute(self, file: str = "", staged: bool = False) -> ToolResult:
        """Get the diff."""
        try:
            cmd = ["git", "diff"]
            if staged:
                cmd.append("--staged")
            if file:
                cmd.append(file)
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                return ToolResult.fail(stderr.decode() if stderr else "Diff failed")
            
            output = stdout.decode() if stdout else ""
            
            if not output:
                return ToolResult.ok("No changes to show")
            
            # Truncate if very long
            if len(output) > 5000:
                output = output[:5000] + "\n\n... (diff truncated, use file parameter for specific file)"
            
            return ToolResult.ok(f"```diff\n{output}\n```")
            
        except Exception as e:
            return ToolResult.fail(f"Git diff failed: {e}")


class GitLogTool(Tool):
    """Get recent git commits."""
    
    @property
    def name(self) -> str:
        return "git_log"
    
    @property
    def description(self) -> str:
        return "Show recent git commits with messages and authors."
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "count": {
                "type": "integer",
                "description": "Number of commits to show (default: 10)",
            },
            "file": {
                "type": "string",
                "description": "Show commits for specific file only",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return []
    
    async def execute(self, count: int = 10, file: str = "") -> ToolResult:
        """Get git log."""
        try:
            cmd = [
                "git", "log", 
                f"-{count}", 
                "--pretty=format:%h | %s | %an | %ar"
            ]
            if file:
                cmd.extend(["--", file])
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                return ToolResult.fail(stderr.decode() if stderr else "Log failed")
            
            output = stdout.decode() if stdout else "No commits found"
            
            result = "📜 **Recent Commits:**\n\n"
            result += "| Hash | Message | Author | When |\n"
            result += "|------|---------|--------|------|\n"
            
            for line in output.strip().split("\n"):
                if "|" in line:
                    parts = [p.strip() for p in line.split("|")]
                    if len(parts) >= 4:
                        result += f"| `{parts[0]}` | {parts[1][:50]} | {parts[2]} | {parts[3]} |\n"
            
            return ToolResult.ok(result)
            
        except Exception as e:
            return ToolResult.fail(f"Git log failed: {e}")


class GitCommitTool(Tool):
    """Create a git commit."""
    
    @property
    def name(self) -> str:
        return "git_commit"
    
    @property
    def description(self) -> str:
        return (
            "Stage all changes and create a commit with the given message. "
            "Use after making and testing changes."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "message": {
                "type": "string",
                "description": "Commit message (be descriptive!)",
            },
            "add_all": {
                "type": "boolean",
                "description": "Stage all changes before committing (default: true)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["message"]
    
    @property
    def is_dangerous(self) -> bool:
        return True
    
    async def execute(self, message: str, add_all: bool = True) -> ToolResult:
        """Create the commit."""
        try:
            # Stage all changes if requested
            if add_all:
                stage_process = await asyncio.create_subprocess_exec(
                    "git", "add", "-A",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await stage_process.communicate()
            
            # Create commit
            process = await asyncio.create_subprocess_exec(
                "git", "commit", "-m", message,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                error = stderr.decode() if stderr else stdout.decode() if stdout else "Commit failed"
                if "nothing to commit" in error.lower():
                    return ToolResult.ok("ℹ️ Nothing to commit - working tree clean")
                return ToolResult.fail(f"Commit failed: {error}")
            
            # Get the commit hash
            hash_process = await asyncio.create_subprocess_exec(
                "git", "rev-parse", "--short", "HEAD",
                stdout=asyncio.subprocess.PIPE,
            )
            hash_stdout, _ = await hash_process.communicate()
            commit_hash = hash_stdout.decode().strip() if hash_stdout else "unknown"
            
            return ToolResult.ok(
                f"✅ **Committed successfully!**\n\n"
                f"- Hash: `{commit_hash}`\n"
                f"- Message: {message}"
            )
            
        except Exception as e:
            return ToolResult.fail(f"Commit failed: {e}")


class GitBranchTool(Tool):
    """List or create git branches."""
    
    @property
    def name(self) -> str:
        return "git_branch"
    
    @property
    def description(self) -> str:
        return "List all branches or create a new branch."
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "name": {
                "type": "string",
                "description": "Name of new branch to create (optional - lists branches if not provided)",
            },
            "checkout": {
                "type": "boolean",
                "description": "Switch to the new branch after creating it",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return []
    
    async def execute(self, name: str = "", checkout: bool = True) -> ToolResult:
        """List or create branches."""
        try:
            if not name:
                # List branches
                process = await asyncio.create_subprocess_exec(
                    "git", "branch", "-a",
                    stdout=asyncio.subprocess.PIPE,
                )
                stdout, _ = await process.communicate()
                output = stdout.decode() if stdout else "No branches"
                return ToolResult.ok(f"🌿 **Branches:**\n```\n{output}\n```")
            
            # Create new branch
            if checkout:
                cmd = ["git", "checkout", "-b", name]
            else:
                cmd = ["git", "branch", name]
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                return ToolResult.fail(stderr.decode() if stderr else "Branch creation failed")
            
            action = "Created and switched to" if checkout else "Created"
            return ToolResult.ok(f"✅ {action} branch `{name}`")
            
        except Exception as e:
            return ToolResult.fail(f"Branch operation failed: {e}")


class GitCheckoutTool(Tool):
    """Switch branches or restore files."""
    
    @property
    def name(self) -> str:
        return "git_checkout"
    
    @property
    def description(self) -> str:
        return "Switch to a different branch or restore a file to its last committed state."
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "target": {
                "type": "string",
                "description": "Branch name to switch to, or file path to restore",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["target"]
    
    @property
    def is_dangerous(self) -> bool:
        return True
    
    async def execute(self, target: str) -> ToolResult:
        """Checkout branch or file."""
        try:
            process = await asyncio.create_subprocess_exec(
                "git", "checkout", target,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                return ToolResult.fail(stderr.decode() if stderr else "Checkout failed")
            
            output = stderr.decode() if stderr else stdout.decode() if stdout else ""
            return ToolResult.ok(f"✅ Checked out `{target}`\n{output}")
            
        except Exception as e:
            return ToolResult.fail(f"Checkout failed: {e}")


# Export tools for discovery
TOOLS = [
    GitStatusTool(),
    GitDiffTool(),
    GitLogTool(),
    GitCommitTool(),
    GitBranchTool(),
    GitCheckoutTool(),
]
