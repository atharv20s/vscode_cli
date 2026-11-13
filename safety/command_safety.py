"""
Enhanced Safety Module for Agentic CLI.

Provides:
- Dangerous command detection and blocking
- Path-based safety checks
- Approval policy enforcement
- Command sanitization
"""

from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Awaitable
from pathlib import Path
import re
import os


class RiskLevel(Enum):
    """Risk levels for commands and operations."""
    SAFE = "safe"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"
    
    @property
    def severity(self) -> int:
        """Get numeric severity for comparison."""
        return {
            "safe": 0,
            "low": 1,
            "medium": 2,
            "high": 3,
            "critical": 4,
        }.get(self.value, 0)


class ApprovalPolicy(Enum):
    """Approval policies for operations."""
    ON_REQUEST = "on-request"  # Ask for each operation
    AUTO = "auto"              # Auto-approve safe operations
    NEVER = "never"            # Never allow dangerous operations
    YOLO = "yolo"              # Approve everything (use at your own risk)


@dataclass
class SafetyCheckResult:
    """Result of a safety check."""
    allowed: bool
    risk_level: RiskLevel
    message: str = ""
    requires_approval: bool = False
    blocked_reason: str = ""
    suggested_alternative: str = ""


@dataclass
class DangerousPattern:
    """A pattern that matches dangerous commands."""
    pattern: str
    risk_level: RiskLevel
    description: str
    category: str
    is_regex: bool = False
    suggested_alternative: str = ""


# Exact, side-effect-free commands that can run without an approval round trip.
# Deliberately excludes file reads, interpreters, package managers and network tools.
SAFE_READ_ONLY_COMMANDS = [
    r"pwd",
    r"whoami",
    r"id",
    r"hostname",
    r"uname(?: -a)?",
    r"git status(?: --short)?",
    r"git diff(?: --stat)?",
    r"git log(?: --oneline(?: -\d+)?)?",
    r"git branch --show-current",
    r"(?:node|python|python3|npm|pnpm|yarn|cargo|go) (?:--version|-v|version)",
]

# Dangerous command patterns for different categories
DANGEROUS_PATTERNS: list[DangerousPattern] = [
    # File system - destructive operations
    DangerousPattern(
        pattern=r"\brm\s+-rf\s+[/~]",
        risk_level=RiskLevel.CRITICAL,
        description="Recursive force delete from root or home",
        category="filesystem",
        is_regex=True,
        suggested_alternative="Be specific about what to delete",
    ),
    DangerousPattern(
        pattern=r"\brm\s+-rf\s+\*",
        risk_level=RiskLevel.HIGH,
        description="Recursive force delete with wildcard",
        category="filesystem",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\brmdir\s+/s\s+/q",
        risk_level=RiskLevel.HIGH,
        description="Windows silent recursive delete",
        category="filesystem",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\bdel\s+/f\s+/s\s+/q",
        risk_level=RiskLevel.HIGH,
        description="Windows force delete all files",
        category="filesystem",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"(^|\\s)(format|mkfs(?:\\.\\w+)?)(\\s|$)",
        risk_level=RiskLevel.CRITICAL,
        description="Disk format command",
        category="filesystem",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r">\s*/dev/sda",
        risk_level=RiskLevel.CRITICAL,
        description="Writing directly to disk device",
        category="filesystem",
        is_regex=True,
    ),
    
    # System - privilege escalation and system changes
    DangerousPattern(
        pattern=r"\bsudo\b",
        risk_level=RiskLevel.HIGH,
        description="Superuser command",
        category="system",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\bchmod\s+777",
        risk_level=RiskLevel.MEDIUM,
        description="Making files world-writable",
        category="system",
        is_regex=True,
        suggested_alternative="Use more restrictive permissions like 755",
    ),
    DangerousPattern(
        pattern=r"\bchown\s+root",
        risk_level=RiskLevel.HIGH,
        description="Changing ownership to root",
        category="system",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\bkill\s+-9",
        risk_level=RiskLevel.MEDIUM,
        description="Force kill process",
        category="system",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\bshutdown\b",
        risk_level=RiskLevel.HIGH,
        description="System shutdown command",
        category="system",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\breboot\b",
        risk_level=RiskLevel.HIGH,
        description="System reboot command",
        category="system",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r">\s*/etc/",
        risk_level=RiskLevel.HIGH,
        description="Writing to system config directory",
        category="system",
        is_regex=True,
    ),
    
    # Network - data exfiltration and remote execution
    DangerousPattern(
        pattern=r"\bcurl\s+.*\|\s*(bash|sh|python)",
        risk_level=RiskLevel.CRITICAL,
        description="Piping remote content to shell",
        category="network",
        is_regex=True,
        suggested_alternative="Download file first, review, then execute",
    ),
    DangerousPattern(
        pattern=r"\bwget\s+.*\|\s*(bash|sh|python)",
        risk_level=RiskLevel.CRITICAL,
        description="Piping remote content to shell",
        category="network",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\bnc\s+-l",
        risk_level=RiskLevel.HIGH,
        description="Starting netcat listener",
        category="network",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\bssh\s+.*@",
        risk_level=RiskLevel.MEDIUM,
        description="SSH connection",
        category="network",
        is_regex=True,
    ),
    
    # Code execution - potentially harmful script execution
    DangerousPattern(
        pattern=r"\beval\s*\(",
        risk_level=RiskLevel.HIGH,
        description="Dynamic code evaluation",
        category="code",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\bexec\s*\(",
        risk_level=RiskLevel.HIGH,
        description="Dynamic code execution",
        category="code",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"__import__\s*\(",
        risk_level=RiskLevel.MEDIUM,
        description="Dynamic module import",
        category="code",
        is_regex=True,
    ),
    
    # Git - destructive operations
    DangerousPattern(
        pattern=r"\bgit\s+push\s+.*--force",
        risk_level=RiskLevel.HIGH,
        description="Force push to remote",
        category="git",
        is_regex=True,
        suggested_alternative="Use --force-with-lease for safer force push",
    ),
    DangerousPattern(
        pattern=r"\bgit\s+reset\s+--hard",
        risk_level=RiskLevel.MEDIUM,
        description="Hard reset losing uncommitted changes",
        category="git",
        is_regex=True,
    ),
    DangerousPattern(
        pattern=r"\bgit\s+clean\s+-fd",
        risk_level=RiskLevel.MEDIUM,
        description="Force clean untracked files",
        category="git",
        is_regex=True,
    ),
]

# Paths that should never be modified
PROTECTED_PATHS = [
    "/",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/dev",
    "/proc",
    "/sys",
    "/root",
    "/var/log",
    "C:\\Windows",
    "C:\\Windows\\System32",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
]

# File patterns that are sensitive
SENSITIVE_FILE_PATTERNS = [
    r"(^|/)\\.env(?:\\..*)?$",
    r"(^|/)\\.npmrc$",
    r"(^|/)\\.pypirc$",
    r"(^|/)\\.netrc$",
    r"(^|/)(?:credentials?|secrets?|service-account)(?:/|$|\\.)",
    r".*\\.(?:pem|key|crt|p8|p12|pfx|jks)$",
    r".*password.*",
    r".*credential.*",
    r".*/\\.ssh/.*",
    r".*/\\.aws/.*",
    r".*/\\.azure/.*",
    r".*/\\.kube/.*",
    r".*/terraform\\.tfstate(?:\\.backup)?$",
]


class CommandSafetyChecker:
    """
    Checks commands for dangerous patterns and enforces safety policies.
    """
    
    def __init__(
        self,
        approval_policy: ApprovalPolicy = ApprovalPolicy.ON_REQUEST,
        additional_patterns: list[DangerousPattern] | None = None,
        additional_protected_paths: list[str] | None = None,
        working_dir: str | None = None,
    ):
        self.approval_policy = approval_policy
        self.patterns = DANGEROUS_PATTERNS.copy()
        if additional_patterns:
            self.patterns.extend(additional_patterns)
        
        self.protected_paths = PROTECTED_PATHS.copy()
        if additional_protected_paths:
            self.protected_paths.extend(additional_protected_paths)
        
        self.working_dir = working_dir or os.getcwd()
        self._approval_callback: Callable[[str, RiskLevel], Awaitable[bool]] | None = None
    
    def set_approval_callback(
        self,
        callback: Callable[[str, RiskLevel], Awaitable[bool]],
    ) -> None:
        """Set the callback for approval requests."""
        self._approval_callback = callback
    
    def check_command(self, command: str) -> SafetyCheckResult:
        """Classify a command using a fail-closed read-only allowlist.

        Only exact, simple inspection commands are auto-allowed. Unknown
        commands and shell composition require explicit user approval.
        Critical destructive commands are denied even under YOLO policy.
        """
        if not isinstance(command, str) or not command.strip():
            return SafetyCheckResult(
                allowed=False,
                risk_level=RiskLevel.HIGH,
                message="Empty or invalid shell command.",
                blocked_reason="A non-empty command string is required.",
            )

        command = command.strip()
        command_lower = command.lower()
        matched_patterns: list[DangerousPattern] = []
        highest_risk = RiskLevel.SAFE

        for pattern in self.patterns:
            try:
                matched = (
                    bool(re.search(pattern.pattern, command, re.IGNORECASE))
                    if pattern.is_regex
                    else pattern.pattern.lower() in command_lower
                )
            except re.error:
                # A malformed custom rule must never make the command safer.
                matched = True
            if matched:
                matched_patterns.append(pattern)
                if pattern.risk_level.severity > highest_risk.severity:
                    highest_risk = pattern.risk_level

        messages = [item.description for item in matched_patterns]
        alternatives = [item.suggested_alternative for item in matched_patterns if item.suggested_alternative]

        if highest_risk == RiskLevel.CRITICAL:
            return SafetyCheckResult(
                allowed=False,
                risk_level=highest_risk,
                message="Blocked critical command: " + ", ".join(messages),
                blocked_reason="Critical destructive or remote-execution pattern is never auto-approved.",
                suggested_alternative=alternatives[0] if alternatives else "",
            )

        # Shell composition is intentionally never part of the automatic allowlist.
        has_shell_operators = bool(re.search(r"[;&|<>\x60$\n\r]", command))
        safe_inspection = any(re.fullmatch(pattern, command, re.IGNORECASE) for pattern in SAFE_READ_ONLY_COMMANDS)
        if not matched_patterns and safe_inspection and not has_shell_operators:
            return SafetyCheckResult(
                allowed=True,
                risk_level=RiskLevel.SAFE,
                message="Allowed read-only inspection command.",
            )

        if self.approval_policy == ApprovalPolicy.YOLO:
            return SafetyCheckResult(
                allowed=True,
                risk_level=highest_risk if matched_patterns else RiskLevel.HIGH,
                message="YOLO policy explicitly allowed a non-critical command.",
            )

        if self.approval_policy == ApprovalPolicy.NEVER:
            return SafetyCheckResult(
                allowed=False,
                risk_level=highest_risk if matched_patterns else RiskLevel.HIGH,
                message="Blocked by the NEVER approval policy.",
                blocked_reason="This policy does not allow commands outside the read-only allowlist.",
                suggested_alternative=alternatives[0] if alternatives else "",
            )

        if self.approval_policy == ApprovalPolicy.AUTO and matched_patterns and highest_risk in (RiskLevel.LOW, RiskLevel.MEDIUM) and not has_shell_operators:
            return SafetyCheckResult(
                allowed=True,
                risk_level=highest_risk,
                message="Auto-approved by the configured low-risk policy.",
            )

        reason = ", ".join(messages) if messages else "Command is not on the read-only allowlist"
        return SafetyCheckResult(
            allowed=False,
            risk_level=highest_risk if matched_patterns else RiskLevel.HIGH,
            message="Approval required: " + reason,
            requires_approval=True,
            suggested_alternative=alternatives[0] if alternatives else "",
        )

    async def check_and_approve(self, command: str) -> SafetyCheckResult:
        """
        Check command and request approval if needed.
        
        Args:
            command: The command to check
            
        Returns:
            SafetyCheckResult after potential approval
        """
        result = self.check_command(command)
        
        if result.requires_approval and self._approval_callback:
            approved = await self._approval_callback(command, result.risk_level)
            return SafetyCheckResult(
                allowed=approved,
                risk_level=result.risk_level,
                message=f"User {'approved' if approved else 'denied'}: {result.message}",
            )
        
        return result


class PathSafetyChecker:
    """
    Checks file paths for safety constraints.
    """
    
    def __init__(
        self,
        working_dir: str | None = None,
        allow_absolute: bool = True,
        allow_outside_working_dir: bool = False,
        protected_paths: list[str] | None = None,
        sensitive_patterns: list[str] | None = None,
    ):
        self.working_dir = Path(working_dir or os.getcwd()).resolve()
        self.allow_absolute = allow_absolute
        self.allow_outside_working_dir = allow_outside_working_dir
        self.protected_paths = protected_paths or PROTECTED_PATHS
        self.sensitive_patterns = sensitive_patterns or SENSITIVE_FILE_PATTERNS
    
    def check_path(
        self,
        path: str,
        operation: str = "access",
    ) -> SafetyCheckResult:
        """
        Check if a path is safe to access.
        
        Args:
            path: The path to check
            operation: The operation type (read, write, delete, etc.)
            
        Returns:
            SafetyCheckResult with path assessment
        """
        try:
            target = Path(path)
            
            # Resolve to absolute path for checking
            if target.is_absolute():
                if not self.allow_absolute:
                    return SafetyCheckResult(
                        allowed=False,
                        risk_level=RiskLevel.MEDIUM,
                        message="Absolute paths are not allowed",
                    )
                resolved = target.resolve()
            else:
                resolved = (self.working_dir / target).resolve()
            
            # Check if outside working directory
            if not self.allow_outside_working_dir:
                try:
                    resolved.relative_to(self.working_dir)
                except ValueError:
                    return SafetyCheckResult(
                        allowed=False,
                        risk_level=RiskLevel.MEDIUM,
                        message=f"Path is outside working directory: {self.working_dir}",
                    )
            
            # Compare path components, not string prefixes (e.g. /etcetera is
            # not a child of /etc). The filesystem root itself is protected,
            # but ordinary workspace paths below it remain usable.
            for protected in self.protected_paths:
                protected_path = Path(protected)
                if not protected_path.is_absolute():
                    continue
                try:
                    protected_resolved = protected_path.resolve()
                    if protected_resolved == Path(protected_resolved.anchor):
                        if resolved == protected_resolved:
                            raise ValueError("workspace root path is protected")
                    elif resolved == protected_resolved or protected_resolved in resolved.parents:
                        raise ValueError(f"path is inside protected location: {protected}")
                except ValueError as error:
                    return SafetyCheckResult(
                        allowed=False,
                        risk_level=RiskLevel.HIGH,
                        message=f"Path is protected: {error}",
                        blocked_reason="System path protection",
                    )

            # Sensitive files are denied by default for both reads and writes.
            resolved_str = resolved.as_posix()
            for pattern in self.sensitive_patterns:
                if re.search(pattern, resolved_str, re.IGNORECASE):
                    return SafetyCheckResult(
                        allowed=False,
                        risk_level=RiskLevel.CRITICAL,
                        message="Access to a sensitive credential/configuration path is blocked.",
                        blocked_reason="Sensitive file access is denied by default.",
                    )
            
            return SafetyCheckResult(
                allowed=True,
                risk_level=risk_level,
                message="Path is safe" if risk_level == RiskLevel.SAFE else "Accessing sensitive file",
            )
            
        except Exception as e:
            return SafetyCheckResult(
                allowed=False,
                risk_level=RiskLevel.MEDIUM,
                message=f"Path validation error: {str(e)}",
            )
    
    def resolve_safe_path(self, path: str) -> Path | None:
        """
        Resolve a path safely within constraints.
        
        Args:
            path: The path to resolve
            
        Returns:
            Resolved Path or None if unsafe
        """
        result = self.check_path(path)
        if result.allowed:
            target = Path(path)
            if target.is_absolute():
                return target.resolve()
            return (self.working_dir / target).resolve()
        return None


@dataclass
class SafetyConfig:
    """Configuration for safety checks."""
    approval_policy: ApprovalPolicy = ApprovalPolicy.ON_REQUEST
    shell_enabled: bool = True
    allow_absolute_paths: bool = True
    allow_outside_working_dir: bool = False
    additional_dangerous_patterns: list[DangerousPattern] = field(default_factory=list)
    additional_protected_paths: list[str] = field(default_factory=list)
    max_command_length: int = 10000


class SafetyManager:
    """
    Central manager for all safety checks.
    """
    
    def __init__(self, config: SafetyConfig | None = None):
        self.config = config or SafetyConfig()
        
        self.command_checker = CommandSafetyChecker(
            approval_policy=self.config.approval_policy,
            additional_patterns=self.config.additional_dangerous_patterns,
            additional_protected_paths=self.config.additional_protected_paths,
        )
        
        self.path_checker = PathSafetyChecker(
            allow_absolute=self.config.allow_absolute_paths,
            allow_outside_working_dir=self.config.allow_outside_working_dir,
            protected_paths=PROTECTED_PATHS + self.config.additional_protected_paths,
        )
    
    def check_command(self, command: str) -> SafetyCheckResult:
        """Check a shell command for safety."""
        if not self.config.shell_enabled:
            return SafetyCheckResult(
                allowed=False,
                risk_level=RiskLevel.MEDIUM,
                message="Shell commands are disabled",
            )
        
        if len(command) > self.config.max_command_length:
            return SafetyCheckResult(
                allowed=False,
                risk_level=RiskLevel.MEDIUM,
                message=f"Command exceeds maximum length of {self.config.max_command_length}",
            )
        
        return self.command_checker.check_command(command)
    
    def check_path(
        self,
        path: str,
        operation: str = "access",
    ) -> SafetyCheckResult:
        """Check a file path for safety."""
        return self.path_checker.check_path(path, operation)
    
    async def check_and_approve_command(self, command: str) -> SafetyCheckResult:
        """Check command and request approval if needed."""
        base_result = self.check_command(command)
        if base_result.blocked_reason or base_result.risk_level == RiskLevel.CRITICAL:
            return base_result
        # Let CommandSafetyChecker invoke the configured callback for ASK
        # decisions. The previous early return made every approval callback
        # unreachable for commands classified as requiring approval.
        return await self.command_checker.check_and_approve(command)
    
    def set_approval_callback(
        self,
        callback: Callable[[str, RiskLevel], Awaitable[bool]],
    ) -> None:
        """Set the approval callback for dangerous operations."""
        self.command_checker.set_approval_callback(callback)


# Global safety manager instance
_safety_manager: SafetyManager | None = None


def get_safety_manager(config: SafetyConfig | None = None) -> SafetyManager:
    """Get the global safety manager instance."""
    global _safety_manager
    if _safety_manager is None or config is not None:
        _safety_manager = SafetyManager(config)
    return _safety_manager
