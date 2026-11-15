"""
Tool Discovery - Automatic tool loading and registration.
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
    def __init__(self, registry: ToolRegistry | None = None):
        self.registry = registry or get_registry()
        self._discovered_modules: list[str] = []

    def discover_builtin(self) -> list[Tool]:
        return self.discover_from_package("tools.builtin")

    def discover_from_package(self, package_name: str) -> list[Tool]:
        discovered: list[Tool] = []
        try:
            package = importlib.import_module(package_name)
        except ImportError as exc:
            print(f"Warning: Could not import package '{package_name}': {exc}")
            return discovered
        if not hasattr(package, "__path__"):
            return discovered
        for _, module_name, _ in pkgutil.iter_modules(package.__path__):
            if module_name.startswith("_"):
                continue
            full_name = f"{package_name}.{module_name}"
            try:
                module = importlib.import_module(full_name)
                for tool in self._extract_tools(module):
                    if not self.registry.has(tool.name):
                        self.registry.register(tool)
                        discovered.append(tool)
                self._discovered_modules.append(full_name)
            except Exception as exc:
                print(f"Warning: Failed to load module '{full_name}': {exc}")
        return discovered

    def discover_from_path(self, path: str | Path) -> list[Tool]:
        path = Path(path)
        discovered: list[Tool] = []
        if not path.exists() or not path.is_dir():
            return discovered
        for py_file in path.glob("*.py"):
            if py_file.name.startswith("_"):
                continue
            try:
                spec = importlib.util.spec_from_file_location(py_file.stem, py_file)
                if spec and spec.loader:
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    for tool in self._extract_tools(module):
                        if not self.registry.has(tool.name):
                            self.registry.register(tool)
                            discovered.append(tool)
            except Exception as exc:
                print(f"Warning: Failed to load '{py_file}': {exc}")
        return discovered

    def _extract_tools(self, module: ModuleType) -> list[Tool]:
        tools: list[Tool] = []
        if hasattr(module, "TOOLS") and isinstance(module.TOOLS, list):
            tools.extend(item for item in module.TOOLS if isinstance(item, Tool))
        if hasattr(module, "get_tools") and callable(module.get_tools):
            result = module.get_tools()
            if isinstance(result, list):
                tools.extend(item for item in result if isinstance(item, Tool) and item not in tools)
        for name in dir(module):
            if not name.startswith("_"):
                obj = getattr(module, name)
                if isinstance(obj, Tool) and obj not in tools:
                    tools.append(obj)
        return tools

    def get_discovered_modules(self) -> list[str]:
        return self._discovered_modules.copy()


def discover_all_tools() -> list[Tool]:
    discovery = ToolDiscovery()
    tools = discovery.discover_builtin()
    # These orchestration tools live outside tools.builtin and must be
    # explicitly registered; previously their modules were never loaded.
    for module_name in ("tools.subagents", "tools.orchestration"):
        try:
            module = importlib.import_module(module_name)
            for tool in discovery._extract_tools(module):
                if not discovery.registry.has(tool.name):
                    discovery.registry.register(tool)
                    tools.append(tool)
        except Exception as exc:
            print(f"Warning: Failed to load orchestration module '{module_name}': {exc}")
    return tools


def setup_tools() -> ToolRegistry:
    discover_all_tools()
    return get_registry()
