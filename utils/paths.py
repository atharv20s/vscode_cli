"""
Path utilities for the Agentic CLI.
"""

from __future__ import annotations
from pathlib import Path
from typing import Union


def display_path_rel_to_cwd(path: Union[str, Path], cwd: Union[str, Path]) -> str:
    """
    Convert a path to a display-friendly relative path.
    
    Args:
        path: The path to convert
        cwd: The current working directory
        
    Returns:
        A relative path string if possible, otherwise the original path
    """
    try:
        path_obj = Path(path).resolve()
        cwd_obj = Path(cwd).resolve()
        
        # Try to get relative path
        try:
            rel_path = path_obj.relative_to(cwd_obj)
            return str(rel_path)
        except ValueError:
            # Path is not relative to cwd, return absolute
            return str(path_obj)
    except Exception:
        return str(path)


def normalize_path(path: Union[str, Path]) -> Path:
    """
    Normalize a path to an absolute Path object.
    
    Args:
        path: Path string or Path object
        
    Returns:
        Resolved absolute Path
    """
    return Path(path).resolve()


def ensure_parent_exists(path: Union[str, Path]) -> Path:
    """
    Ensure the parent directory of a path exists.
    
    Args:
        path: Path to file
        
    Returns:
        The path as a Path object
    """
    path_obj = Path(path)
    path_obj.parent.mkdir(parents=True, exist_ok=True)
    return path_obj


def is_safe_path(path: Union[str, Path], allowed_root: Union[str, Path]) -> bool:
    """
    Check if a path is within an allowed root directory.
    
    Args:
        path: Path to check
        allowed_root: The allowed root directory
        
    Returns:
        True if path is within allowed_root
    """
    try:
        path_obj = Path(path).resolve()
        root_obj = Path(allowed_root).resolve()
        return str(path_obj).startswith(str(root_obj))
    except Exception:
        return False


def get_file_extension(path: Union[str, Path]) -> str:
    """
    Get the file extension of a path.
    
    Args:
        path: Path to file
        
    Returns:
        File extension (lowercase) including the dot, or empty string
    """
    return Path(path).suffix.lower()


def split_path_and_line(path_spec: str) -> tuple[str, int | None]:
    """
    Split a path specification that may include a line number.
    
    Examples:
        "file.py:10" -> ("file.py", 10)
        "file.py" -> ("file.py", None)
        
    Args:
        path_spec: Path possibly with :line_number suffix
        
    Returns:
        Tuple of (path, line_number or None)
    """
    if ":" in path_spec:
        parts = path_spec.rsplit(":", 1)
        if parts[1].isdigit():
            return parts[0], int(parts[1])
    return path_spec, None
