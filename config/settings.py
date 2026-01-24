"""
Application settings and configuration.
"""

from __future__ import annotations
import os
from dataclasses import dataclass


@dataclass
class Settings:
    """Application settings."""
    
    # API Configuration
    api_key: str = ""
    api_base_url: str = "https://openrouter.ai/api/v1"
    model: str = "mistralai/devstral-2512:free"
    
    # Retry Configuration
    max_retries: int = 4
    retry_base_delay: float = 2.0
    
    # UI Configuration
    show_welcome: bool = True
    default_persona: str = "default"
    
    # Agent Configuration
    max_iterations: int = 10  # Max tool calling loops
    show_turn_count: bool = True  # Show turn numbers in TUI
    agents_md_path: str = "AGENTS.md"  # Path to custom instructions
    load_agents_md: bool = True  # Whether to load AGENTS.md


# Singleton settings instance
_settings: Settings | None = None


def get_settings() -> Settings:
    """Get or create the settings instance."""
    global _settings
    
    if _settings is None:
        _settings = Settings(
            api_key=os.getenv(
                "OPENROUTER_API_KEY",
                "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"
            ),
            api_base_url=os.getenv(
                "OPENROUTER_BASE_URL",
                "https://openrouter.ai/api/v1"
            ),
            model=os.getenv(
                "OPENROUTER_MODEL",
                "mistralai/devstral-2512:free"
            ),
        )
    
    return _settings


def update_settings(**kwargs) -> Settings:
    """Update settings with new values."""
    global _settings
    settings = get_settings()
    
    for key, value in kwargs.items():
        if hasattr(settings, key):
            setattr(settings, key, value)
    
    return settings


def load_agents_md(path: str = "AGENTS.md") -> str | None:
    """Load custom instructions from AGENTS.md file.
    
    Args:
        path: Path to the AGENTS.md file
        
    Returns:
        The contents of the file, or None if not found
    """
    import os
    
    # Check multiple possible locations
    search_paths = [
        path,
        os.path.join(os.getcwd(), path),
        os.path.join(os.path.dirname(os.path.dirname(__file__)), path),
    ]
    
    for file_path in search_paths:
        if os.path.exists(file_path):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    return f.read()
            except Exception:
                pass
    
    return None
