"""
Theme definitions for the terminal UI.
"""

from rich.theme import Theme


AGENT_THEME = Theme(
    {
        # General
        "info": "cyan",
        "warning": "yellow",
        "error": "bright_red bold",
        "success": "green",
        "dim": "dim",
        "muted": "grey50",
        "border": "grey35",
        "highlight": "bold cyan",
        
        # Roles
        "user": "bright_blue bold",
        "assistant": "bright_white",
        "system": "dim italic",
        
        # Tools
        "tool": "bright_magenta bold",
        "tool.read": "cyan",
        "tool.write": "yellow",
        "tool.shell": "magenta",
        "tool.network": "bright_blue",
        "tool.memory": "green",
        
        # Code / blocks
        "code": "white",
        "code.keyword": "bright_magenta",
        "code.string": "bright_green",
        "code.comment": "dim",
        
        # Status
        "thinking": "dim italic",
        "streaming": "bright_green",
        "loading": "cyan",
        
        # Severity
        "critical": "bright_red bold",
        "high": "red",
        "medium": "yellow",
        "low": "dim",
    }
)
