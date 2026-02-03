"""
Utility functions and helpers.
"""

from __future__ import annotations
import time
from typing import Any


def truncate_text(text: str, max_length: int = 100, suffix: str = "...") -> str:
    """Truncate text to a maximum length.
    
    Args:
        text: The text to truncate
        max_length: Maximum length (including suffix)
        suffix: Suffix to add when truncated
        
    Returns:
        Truncated text
    """
    if len(text) <= max_length:
        return text
    return text[:max_length - len(suffix)] + suffix


def format_duration(seconds: float) -> str:
    """Format a duration in seconds to a human-readable string.
    
    Args:
        seconds: Duration in seconds
        
    Returns:
        Formatted string like "1.23s" or "45ms"
    """
    if seconds < 0.001:
        return f"{seconds * 1000000:.0f}μs"
    elif seconds < 1:
        return f"{seconds * 1000:.0f}ms"
    elif seconds < 60:
        return f"{seconds:.2f}s"
    else:
        minutes = int(seconds // 60)
        secs = seconds % 60
        return f"{minutes}m {secs:.0f}s"


def count_tokens(text: str) -> int:
    """Estimate token count for text.
    
    This is a rough estimate based on word count.
    For accurate counts, use tiktoken or similar.
    
    Args:
        text: The text to count tokens for
        
    Returns:
        Estimated token count
    """
    # Rough estimate: ~4 characters per token for English
    return len(text) // 4


class Timer:
    """Context manager for timing code blocks."""
    
    def __init__(self):
        self.start_time: float = 0
        self.end_time: float = 0
    
    def __enter__(self) -> Timer:
        self.start_time = time.perf_counter()
        return self
    
    def __exit__(self, *args) -> None:
        self.end_time = time.perf_counter()
    
    @property
    def elapsed(self) -> float:
        """Get elapsed time in seconds."""
        if self.end_time:
            return self.end_time - self.start_time
        return time.perf_counter() - self.start_time
    
    @property
    def elapsed_formatted(self) -> str:
        """Get elapsed time as formatted string."""
        return format_duration(self.elapsed)


def deep_merge(base: dict, override: dict) -> dict:
    """Deep merge two dictionaries.
    
    Args:
        base: Base dictionary
        override: Dictionary with values to override
        
    Returns:
        Merged dictionary
    """
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result
