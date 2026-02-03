"""
Input validation for user inputs.
"""

from __future__ import annotations
from dataclasses import dataclass
import re


@dataclass
class ValidationResult:
    """Result of input validation."""
    is_valid: bool
    message: str = ""
    sanitized_input: str = ""


class InputValidator:
    """Validates and sanitizes user inputs."""
    
    def __init__(
        self,
        max_length: int = 100000,
        min_length: int = 1,
        block_patterns: list[str] | None = None,
    ):
        """Initialize the validator.
        
        Args:
            max_length: Maximum allowed input length
            min_length: Minimum required input length
            block_patterns: Regex patterns to block
        """
        self.max_length = max_length
        self.min_length = min_length
        self.block_patterns = block_patterns or []
    
    def validate(self, text: str) -> ValidationResult:
        """Validate user input.
        
        Args:
            text: The input text to validate
            
        Returns:
            ValidationResult with status and sanitized input
        """
        # Check for empty input
        if not text or len(text.strip()) < self.min_length:
            return ValidationResult(
                is_valid=False,
                message=f"Input must be at least {self.min_length} character(s)",
            )
        
        # Check length
        if len(text) > self.max_length:
            return ValidationResult(
                is_valid=False,
                message=f"Input exceeds maximum length of {self.max_length}",
            )
        
        # Check blocked patterns
        for pattern in self.block_patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return ValidationResult(
                    is_valid=False,
                    message="Input contains blocked content",
                )
        
        # Sanitize and return
        sanitized = self._sanitize(text)
        return ValidationResult(
            is_valid=True,
            sanitized_input=sanitized,
        )
    
    def _sanitize(self, text: str) -> str:
        """Sanitize input text."""
        # Strip leading/trailing whitespace
        text = text.strip()
        
        # Normalize line endings
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        
        # Remove null bytes
        text = text.replace("\x00", "")
        
        return text
