"""
Text utilities for the Agentic CLI.
"""

from __future__ import annotations
from typing import Optional


def truncate_text(
    text: str,
    model_name: Optional[str] = None,
    max_tokens: int = 2500,
    suffix: str = "\n\n... [truncated]"
) -> str:
    """
    Truncate text to approximately max_tokens.
    
    Uses a simple character-based estimation (4 chars ~= 1 token).
    
    Args:
        text: Text to truncate
        model_name: Model name (unused, for future token counting)
        max_tokens: Maximum tokens to allow
        suffix: Suffix to append if truncated
        
    Returns:
        Truncated text with suffix if needed
    """
    # Rough estimation: 4 characters per token
    max_chars = max_tokens * 4
    
    if len(text) <= max_chars:
        return text
    
    # Find a good break point
    truncated = text[:max_chars]
    
    # Try to break at a newline
    last_newline = truncated.rfind('\n')
    if last_newline > max_chars * 0.8:  # Only if we're not losing too much
        truncated = truncated[:last_newline]
    
    return truncated + suffix


def count_tokens_estimate(text: str) -> int:
    """
    Estimate token count for text.
    
    Args:
        text: Text to count
        
    Returns:
        Estimated token count
    """
    # Rough estimation: 4 characters per token
    return len(text) // 4


def word_wrap(text: str, width: int = 80) -> str:
    """
    Word wrap text to specified width.
    
    Args:
        text: Text to wrap
        width: Maximum line width
        
    Returns:
        Wrapped text
    """
    lines = []
    for paragraph in text.split('\n'):
        if len(paragraph) <= width:
            lines.append(paragraph)
            continue
        
        words = paragraph.split(' ')
        current_line = []
        current_length = 0
        
        for word in words:
            if current_length + len(word) + 1 <= width:
                current_line.append(word)
                current_length += len(word) + 1
            else:
                if current_line:
                    lines.append(' '.join(current_line))
                current_line = [word]
                current_length = len(word)
        
        if current_line:
            lines.append(' '.join(current_line))
    
    return '\n'.join(lines)


def strip_ansi(text: str) -> str:
    """
    Remove ANSI escape codes from text.
    
    Args:
        text: Text with potential ANSI codes
        
    Returns:
        Clean text without ANSI codes
    """
    import re
    ansi_pattern = re.compile(r'\x1b\[[0-9;]*m')
    return ansi_pattern.sub('', text)


def indent(text: str, prefix: str = "  ") -> str:
    """
    Indent each line of text.
    
    Args:
        text: Text to indent
        prefix: Prefix to add to each line
        
    Returns:
        Indented text
    """
    lines = text.split('\n')
    return '\n'.join(prefix + line for line in lines)


def dedent(text: str) -> str:
    """
    Remove common leading whitespace from all lines.
    
    Args:
        text: Text to dedent
        
    Returns:
        Dedented text
    """
    import textwrap
    return textwrap.dedent(text)


def highlight_match(text: str, pattern: str, before: str = "**", after: str = "**") -> str:
    """
    Highlight matches of a pattern in text.
    
    Args:
        text: Text to search in
        pattern: Pattern to highlight
        before: String to insert before matches
        after: String to insert after matches
        
    Returns:
        Text with highlighted matches
    """
    import re
    try:
        return re.sub(
            f'({re.escape(pattern)})',
            f'{before}\\1{after}',
            text,
            flags=re.IGNORECASE
        )
    except Exception:
        return text


def pluralize(count: int, singular: str, plural: Optional[str] = None) -> str:
    """
    Return singular or plural form based on count.
    
    Args:
        count: The count
        singular: Singular form
        plural: Plural form (default: singular + 's')
        
    Returns:
        Appropriate form with count
    """
    plural = plural or singular + 's'
    word = singular if count == 1 else plural
    return f"{count} {word}"
