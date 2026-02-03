"""
Configuration class for the Agentic CLI.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from enum import Enum
import os


class ApprovalMode(Enum):
    """Approval mode for tool execution."""
    ALWAYS = "always"       # Always ask for approval
    WRITE = "write"         # Only for write operations
    NEVER = "never"         # Never ask (auto-approve)
    SUGGEST = "suggest"     # Suggest but don't require


@dataclass
class Config:
    """
    Main configuration for the Agentic CLI.
    
    Attributes:
        cwd: Current working directory
        model_name: Name of the LLM model
        api_key: API key for the LLM provider
        api_base_url: Base URL for the API
        approval_mode: When to require approval
        max_tokens: Max tokens for responses
        temperature: Temperature for generation
        max_iterations: Max tool calling iterations
        show_welcome: Show welcome message
        show_turn_count: Show turn numbers
        agents_md_path: Path to AGENTS.md
        load_agents_md: Whether to load AGENTS.md
    """
    # Core settings
    cwd: Path = field(default_factory=Path.cwd)
    model_name: str = "mistralai/devstral-2512:free"
    
    # API settings
    api_key: str = ""
    api_base_url: str = "https://openrouter.ai/api/v1"
    
    # Approval settings
    approval_mode: ApprovalMode = ApprovalMode.WRITE
    
    # Generation settings
    max_tokens: int = 4096
    temperature: float = 0.7
    
    # Agent settings
    max_iterations: int = 25
    show_welcome: bool = True
    show_turn_count: bool = True
    
    # Custom instructions
    agents_md_path: str = "AGENTS.md"
    load_agents_md: bool = True
    
    # Session settings
    session_id: Optional[str] = None
    checkpoint_enabled: bool = True
    
    def __post_init__(self):
        """Initialize after dataclass creation."""
        if isinstance(self.cwd, str):
            self.cwd = Path(self.cwd)
        if isinstance(self.approval_mode, str):
            self.approval_mode = ApprovalMode(self.approval_mode)
    
    @classmethod
    def from_env(cls) -> Config:
        """Create config from environment variables."""
        return cls(
            cwd=Path(os.getenv("AGENTIC_CWD", os.getcwd())),
            model_name=os.getenv("AGENTIC_MODEL", "mistralai/devstral-2512:free"),
            api_key=os.getenv("OPENROUTER_API_KEY", ""),
            api_base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
            approval_mode=ApprovalMode(os.getenv("AGENTIC_APPROVAL", "write")),
            max_tokens=int(os.getenv("AGENTIC_MAX_TOKENS", "4096")),
            temperature=float(os.getenv("AGENTIC_TEMPERATURE", "0.7")),
            max_iterations=int(os.getenv("AGENTIC_MAX_ITERATIONS", "25")),
        )
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "cwd": str(self.cwd),
            "model_name": self.model_name,
            "api_base_url": self.api_base_url,
            "approval_mode": self.approval_mode.value,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "max_iterations": self.max_iterations,
            "show_welcome": self.show_welcome,
            "show_turn_count": self.show_turn_count,
            "agents_md_path": self.agents_md_path,
            "load_agents_md": self.load_agents_md,
            "session_id": self.session_id,
            "checkpoint_enabled": self.checkpoint_enabled,
        }
    
    def requires_approval(self, tool_kind: str) -> bool:
        """Check if a tool kind requires approval."""
        if self.approval_mode == ApprovalMode.NEVER:
            return False
        if self.approval_mode == ApprovalMode.ALWAYS:
            return True
        if self.approval_mode == ApprovalMode.WRITE:
            return tool_kind in {"write", "shell", "dangerous"}
        return False


# Singleton config instance
_config: Config | None = None


def get_config() -> Config:
    """Get the global config instance."""
    global _config
    if _config is None:
        _config = Config.from_env()
    return _config


def set_config(config: Config) -> None:
    """Set the global config instance."""
    global _config
    _config = config
