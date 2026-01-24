"""
Tool Discovery - Automatic tool loading and registration.

This module handles:
- Auto-discovery of tools from the builtin/ folder
- Dynamic loading of tool modules
- Registration with the global registry
"""

from __future__ import annotations
import importlib
import pkgutil
from pathlib import Path
from typing import TYPE_CHECKING

from tools.base import Tool
from tools.registry import get_registry, ToolRegistry

if TYPE_CHECKING:
    from types import ModuleType


class ToolDiscovery:
    """
    Discovers and loads tools from specified packages.
    
    Usage:
        discovery = ToolDiscovery()
        discovery.discover_builtin()  # Load all builtin tools
        discovery.discover_from_path("my_tools")  # Load custom tools
    """
    
    def __init__(self, registry: ToolRegistry | None = None):
        """
        Initialize the discovery system.
        
        Args:
            registry: Tool registry to use (defaults to global)
        """
        self.registry = registry or get_registry()
        self._discovered_modules: list[str] = []
    
    def discover_builtin(self) -> list[Tool]:
        """
        Discover and register all builtin tools.
        
        Returns:
            List of discovered tools
        """
        return self.discover_from_package("tools.builtin")
    
    def discover_from_package(self, package_name: str) -> list[Tool]:
        """
        Discover tools from a Python package.
        
        Args:
            package_name: Fully qualified package name (e.g., "tools.builtin")
            
        Returns:
            List of discovered tools
        """
        discovered: list[Tool] = []
        
        try:
            package = importlib.import_module(package_name)
        except ImportError as e:
            print(f"Warning: Could not import package '{package_name}': {e}")
            return discovered
        
        # Get the package path
        if not hasattr(package, "__path__"):
            return discovered
        
        # Iterate through all modules in the package
        for importer, module_name, is_pkg in pkgutil.iter_modules(package.__path__):
            if module_name.startswith("_"):
                continue  # Skip private modules
            
            full_name = f"{package_name}.{module_name}"
            
            try:
                module = importlib.import_module(full_name)
                tools = self._extract_tools(module)
                
                for tool in tools:
                    if not self.registry.has(tool.name):
                        self.registry.register(tool)
                        discovered.append(tool)
                
                self._discovered_modules.append(full_name)
                
            except Exception as e:
                print(f"Warning: Failed to load module '{full_name}': {e}")
        
        return discovered
    
    def discover_from_path(self, path: str | Path) -> list[Tool]:
        """
        Discover tools from a filesystem path.
        
        Args:
            path: Path to directory containing tool modules
            
        Returns:
            List of discovered tools
        """
        path = Path(path)
        discovered: list[Tool] = []
        
        if not path.exists() or not path.is_dir():
            return discovered
        
        for py_file in path.glob("*.py"):
            if py_file.name.startswith("_"):
                continue
            
            module_name = py_file.stem
            
            try:
                spec = importlib.util.spec_from_file_location(module_name, py_file)
                if spec and spec.loader:
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    
                    tools = self._extract_tools(module)
                    for tool in tools:
                        if not self.registry.has(tool.name):
                            self.registry.register(tool)
                            discovered.append(tool)
                            
            except Exception as e:
                print(f"Warning: Failed to load '{py_file}': {e}")
        
        return discovered
    
    def _extract_tools(self, module: ModuleType) -> list[Tool]:
        """
        Extract Tool instances from a module.
        
        Looks for:
        - Instances of Tool class
        - A 'get_tools()' function that returns tools
        - A 'TOOLS' list variable
        """
        tools: list[Tool] = []
        
        # Check for TOOLS list
        if hasattr(module, "TOOLS"):
            tools_list = getattr(module, "TOOLS")
            if isinstance(tools_list, list):
                for item in tools_list:
                    if isinstance(item, Tool):
                        tools.append(item)
        
        # Check for get_tools() function
        if hasattr(module, "get_tools"):
            get_tools_fn = getattr(module, "get_tools")
            if callable(get_tools_fn):
                result = get_tools_fn()
                if isinstance(result, list):
                    for item in result:
                        if isinstance(item, Tool):
                            tools.append(item)
        
        # Check for Tool instances at module level
        for name in dir(module):
            if name.startswith("_"):
                continue
            obj = getattr(module, name)
            if isinstance(obj, Tool) and obj not in tools:
                tools.append(obj)
        
        return tools
    
    def get_discovered_modules(self) -> list[str]:
        """Get list of all discovered module names."""
        return self._discovered_modules.copy()


def discover_all_tools() -> list[Tool]:
    """
    Convenience function to discover all available tools.
    
    Returns:
        List of all discovered tools
    """
    discovery = ToolDiscovery()
    tools = discovery.discover_builtin()
    return tools


def setup_tools() -> ToolRegistry:
    """
    Setup the tool system with all available tools.
    
    Returns:
        The configured registry
    """
    discover_all_tools()
    return get_registry()
