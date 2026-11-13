"""
Input validation for agent requests.
"""

from __future__ import annotations
from dataclasses import dataclass
import re
import unicodedata


@dataclass
class ValidationResult:
    is_valid: bool
    message: str = ""
    sanitized_input: str = ""


class InputValidator:
    """Bounds and normalizes user input without trying to interpret its intent."""

    def __init__(
        self,
        max_length: int = 100_000,
        min_length: int = 1,
        block_patterns: list[str] | None = None,
    ):
        if max_length < 1 or min_length < 0 or min_length > max_length:
            raise ValueError("Invalid input length limits.")
        self.max_length = max_length
        self.min_length = min_length
        self.block_patterns: list[re.Pattern[str]] = []
        for pattern in block_patterns or []:
            try:
                self.block_patterns.append(re.compile(pattern, re.IGNORECASE))
            except re.error as error:
                raise ValueError("Invalid input block pattern: " + str(error)) from error

    def validate(self, text: str) -> ValidationResult:
        if not isinstance(text, str):
            return ValidationResult(False, "Input must be a string.")
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        normalized = unicodedata.normalize("NFC", normalized).strip()
        if len(normalized) < self.min_length:
            return ValidationResult(False, f"Input must be at least {self.min_length} character(s).")
        if len(normalized) > self.max_length:
            return ValidationResult(False, f"Input exceeds maximum length of {self.max_length}.")
        if any(ord(char) < 32 and char not in "\n\t" for char in normalized):
            return ValidationResult(False, "Input contains unsupported control characters.")
        if any(char in normalized for char in ("\u202a", "\u202b", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069")):
            return ValidationResult(False, "Input contains bidirectional override controls.")
        for pattern in self.block_patterns:
            if pattern.search(normalized):
                return ValidationResult(False, "Input contains blocked content.")
        return ValidationResult(True, sanitized_input=normalized)
