"""
Content filtering for safety.
"""

from __future__ import annotations
from dataclasses import dataclass
from enum import Enum


class FilterAction(str, Enum):
    """Actions to take when content is filtered."""
    ALLOW = "allow"
    WARN = "warn"
    BLOCK = "block"


@dataclass
class FilterResult:
    """Result of content filtering."""
    action: FilterAction
    reason: str = ""
    flagged_content: str = ""


class ContentFilter:
    """Filters content for safety concerns."""
    
    def __init__(self, strict_mode: bool = False):
        """Initialize the content filter.
        
        Args:
            strict_mode: If True, applies stricter filtering rules
        """
        self.strict_mode = strict_mode
    
    def filter_input(self, text: str) -> FilterResult:
        """Filter user input.
        
        Args:
            text: The input text to filter
            
        Returns:
            FilterResult with action and reason
        """
        # Default: allow all input (implement your own rules)
        return FilterResult(action=FilterAction.ALLOW)
    
    def filter_output(self, text: str) -> FilterResult:
        """Filter model output.
        
        Args:
            text: The output text to filter
            
        Returns:
            FilterResult with action and reason
        """
        # Default: allow all output (implement your own rules)
        return FilterResult(action=FilterAction.ALLOW)
