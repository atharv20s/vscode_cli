"""
Code Intelligence Tools - AST analysis, execution, linting, and debugging.

These tools give the agent deep understanding of code structure,
ability to execute and test code, and find issues automatically.

Gaps Addressed:
- LLMs can't RUN code to verify it works
- LLMs guess at code structure instead of analyzing
- LLMs can't lint or type-check
- LLMs don't know about runtime errors
"""

from __future__ import annotations
import ast
import sys
import asyncio
from typing import Any
from pathlib import Path

from tools.base import Tool, ToolResult


class AnalyzeCodeTool(Tool):
    """
    Analyze Python code structure using AST.
    
    Gap Addressed: LLMs guess at code structure. This tool gives
    ACTUAL structure - functions, classes, imports, dependencies.
    """
    
    @property
    def name(self) -> str:
        return "analyze_code"
    
    @property
    def description(self) -> str:
        return (
            "Analyze Python code to extract functions, classes, imports, "
            "and structure. Use BEFORE modifying code to understand it. "
            "Returns detailed code analysis with line numbers."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "path": {
                "type": "string",
                "description": "Path to Python file to analyze",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["path"]
    
    async def execute(self, path: str) -> ToolResult:
        """Analyze the code structure."""
        try:
            file_path = Path(path).resolve()
            if not file_path.exists():
                return ToolResult.fail(f"File not found: {path}")
            
            code = file_path.read_text(encoding="utf-8")
            tree = ast.parse(code)
            
            analysis = {
                "functions": [],
                "classes": [],
                "imports": [],
                "async_functions": [],
                "decorators_used": set(),
                "type_hints_used": False,
            }
            
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef):
                    args = []
                    for a in node.args.args:
                        arg_info = a.arg
                        if a.annotation:
                            analysis["type_hints_used"] = True
                            arg_info += f": {ast.unparse(a.annotation)}"
                        args.append(arg_info)
                    
                    return_hint = ""
                    if node.returns:
                        analysis["type_hints_used"] = True
                        return_hint = f" -> {ast.unparse(node.returns)}"
                    
                    analysis["functions"].append({
                        "name": node.name,
                        "args": args,
                        "line": node.lineno,
                        "docstring": ast.get_docstring(node) or "",
                        "decorators": [ast.unparse(d) for d in node.decorator_list],
                        "return_hint": return_hint,
                    })
                    
                    for d in node.decorator_list:
                        analysis["decorators_used"].add(ast.unparse(d))
                
                elif isinstance(node, ast.AsyncFunctionDef):
                    analysis["async_functions"].append({
                        "name": node.name,
                        "line": node.lineno,
                    })
                
                elif isinstance(node, ast.ClassDef):
                    methods = []
                    properties = []
                    for item in node.body:
                        if isinstance(item, ast.FunctionDef):
                            if any(isinstance(d, ast.Name) and d.id == "property" 
                                   for d in item.decorator_list):
                                properties.append(item.name)
                            else:
                                methods.append(item.name)
                    
                    bases = [ast.unparse(b) for b in node.bases]
                    
                    analysis["classes"].append({
                        "name": node.name,
                        "bases": bases,
                        "methods": methods,
                        "properties": properties,
                        "line": node.lineno,
                        "docstring": ast.get_docstring(node) or "",
                    })
                
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        analysis["imports"].append({
                            "module": alias.name,
                            "alias": alias.asname,
                            "type": "import",
                        })
                
                elif isinstance(node, ast.ImportFrom):
                    for alias in node.names:
                        analysis["imports"].append({
                            "module": f"{node.module}.{alias.name}" if node.module else alias.name,
                            "alias": alias.asname,
                            "type": "from_import",
                        })
            
            # Convert set to list
            analysis["decorators_used"] = list(analysis["decorators_used"])
            
            # Build output
            output = f"📊 **Code Analysis: {file_path.name}**\n\n"
            output += f"📍 Lines of code: {len(code.splitlines())}\n"
            output += f"📍 Type hints: {'Yes ✅' if analysis['type_hints_used'] else 'No ❌'}\n\n"
            
            if analysis["imports"]:
                output += f"**📦 Imports ({len(analysis['imports'])}):**\n"
                for imp in analysis["imports"][:15]:
                    alias_str = f" as {imp['alias']}" if imp['alias'] else ""
                    output += f"  - `{imp['module']}`{alias_str}\n"
                if len(analysis["imports"]) > 15:
                    output += f"  - ... and {len(analysis['imports']) - 15} more\n"
            
            if analysis["classes"]:
                output += f"\n**🏛️ Classes ({len(analysis['classes'])}):**\n"
                for cls in analysis["classes"]:
                    bases_str = f"({', '.join(cls['bases'])})" if cls['bases'] else ""
                    output += f"  - `{cls['name']}{bases_str}` @ line {cls['line']}\n"
                    output += f"    Methods: {', '.join(cls['methods'][:5])}\n"
                    if cls['properties']:
                        output += f"    Properties: {', '.join(cls['properties'])}\n"
            
            if analysis["functions"]:
                output += f"\n**⚙️ Functions ({len(analysis['functions'])}):**\n"
                for fn in analysis["functions"]:
                    args_str = ", ".join(fn["args"][:4])
                    if len(fn["args"]) > 4:
                        args_str += ", ..."
                    output += f"  - `{fn['name']}({args_str}){fn['return_hint']}` @ line {fn['line']}\n"
            
            if analysis["async_functions"]:
                output += f"\n**⚡ Async Functions:** {', '.join(f['name'] for f in analysis['async_functions'])}\n"
            
            return ToolResult.ok(output, analysis=analysis)
            
        except SyntaxError as e:
            return ToolResult.fail(f"Syntax error in file: {e}")
        except Exception as e:
            return ToolResult.fail(f"Analysis failed: {e}")


class RunPythonTool(Tool):
    """
    Execute Python code and return output.
    
    Gap Addressed: LLMs can't verify their code works.
    This lets the agent TEST code before claiming it's done.
    """
    
    @property
    def name(self) -> str:
        return "run_python"
    
    @property
    def description(self) -> str:
        return (
            "Execute Python code and return stdout/stderr output. "
            "Use this to TEST code snippets, verify fixes work, "
            "or run scripts. Shows actual runtime behavior."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "code": {
                "type": "string",
                "description": "Python code to execute",
            },
            "timeout": {
                "type": "integer",
                "description": "Timeout in seconds (default: 30)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["code"]
    
    @property
    def is_dangerous(self) -> bool:
        return True
    
    async def execute(self, code: str, timeout: int = 30) -> ToolResult:
        """Execute the Python code."""
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c", code,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), 
                    timeout=float(timeout)
                )
            except asyncio.TimeoutError:
                process.kill()
                return ToolResult.fail(f"⏱️ Execution timed out after {timeout}s")
            
            stdout_str = stdout.decode() if stdout else ""
            stderr_str = stderr.decode() if stderr else ""
            
            if process.returncode != 0:
                output = f"❌ **Exit code: {process.returncode}**\n\n"
                if stderr_str:
                    output += f"**Stderr:**\n```\n{stderr_str}\n```\n"
                if stdout_str:
                    output += f"**Stdout:**\n```\n{stdout_str}\n```"
                return ToolResult.fail(output)
            
            output = "✅ **Execution successful**\n\n"
            if stdout_str:
                output += f"**Output:**\n```\n{stdout_str}\n```"
            else:
                output += "(no output)"
            
            if stderr_str:
                output += f"\n\n**Warnings:**\n```\n{stderr_str}\n```"
            
            return ToolResult.ok(output, exit_code=process.returncode)
            
        except Exception as e:
            return ToolResult.fail(f"Execution failed: {e}")


class RunPythonFileTool(Tool):
    """Execute a Python file."""
    
    @property
    def name(self) -> str:
        return "run_python_file"
    
    @property
    def description(self) -> str:
        return (
            "Execute a Python file and return its output. "
            "Use to test scripts or run programs."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "path": {
                "type": "string",
                "description": "Path to Python file to run",
            },
            "args": {
                "type": "string",
                "description": "Command line arguments (optional)",
            },
            "timeout": {
                "type": "integer",
                "description": "Timeout in seconds (default: 60)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["path"]
    
    @property
    def is_dangerous(self) -> bool:
        return True
    
    async def execute(
        self, 
        path: str, 
        args: str = "", 
        timeout: int = 60
    ) -> ToolResult:
        """Execute the Python file."""
        try:
            file_path = Path(path).resolve()
            if not file_path.exists():
                return ToolResult.fail(f"File not found: {path}")
            
            cmd = [sys.executable, str(file_path)]
            if args:
                cmd.extend(args.split())
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=file_path.parent,
            )
            
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), 
                    timeout=float(timeout)
                )
            except asyncio.TimeoutError:
                process.kill()
                return ToolResult.fail(f"⏱️ Timed out after {timeout}s")
            
            stdout_str = stdout.decode() if stdout else ""
            stderr_str = stderr.decode() if stderr else ""
            
            if process.returncode != 0:
                return ToolResult.fail(
                    f"❌ Exit code {process.returncode}\n{stderr_str}"
                )
            
            output = f"✅ **{file_path.name}** ran successfully\n\n"
            if stdout_str:
                # Truncate if too long
                if len(stdout_str) > 2000:
                    stdout_str = stdout_str[:2000] + "\n... (truncated)"
                output += f"```\n{stdout_str}\n```"
            else:
                output += "(no output)"
            
            return ToolResult.ok(output)
            
        except Exception as e:
            return ToolResult.fail(f"Failed: {e}")


class LintCodeTool(Tool):
    """
    Lint Python code for errors and style issues.
    
    Gap Addressed: LLMs suggest code but can't check quality.
    This catches real issues: unused imports, type errors, style.
    """
    
    @property
    def name(self) -> str:
        return "lint_code"
    
    @property
    def description(self) -> str:
        return (
            "Check Python code for errors, style issues, and improvements "
            "using ruff (fast Python linter). Returns specific issues with "
            "line numbers and fix suggestions."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "path": {
                "type": "string",
                "description": "Path to Python file to lint",
            },
            "fix": {
                "type": "boolean",
                "description": "Auto-fix issues if possible (default: false)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["path"]
    
    async def execute(self, path: str, fix: bool = False) -> ToolResult:
        """Lint the file."""
        try:
            file_path = Path(path).resolve()
            if not file_path.exists():
                return ToolResult.fail(f"File not found: {path}")
            
            cmd = [sys.executable, "-m", "ruff", "check", str(file_path)]
            if fix:
                cmd.append("--fix")
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()
            
            output = stdout.decode() if stdout else ""
            
            if not output or process.returncode == 0:
                return ToolResult.ok(f"✅ **{file_path.name}** - No issues found!")
            
            # Count issues
            lines = output.strip().split("\n")
            issue_count = len([l for l in lines if l.strip() and ":" in l])
            
            result = f"⚠️ **{file_path.name}** - {issue_count} issues:\n\n```\n{output}\n```"
            return ToolResult.ok(result, issue_count=issue_count)
            
        except Exception as e:
            return ToolResult.fail(f"Lint failed (is ruff installed?): {e}")


class FindDefinitionTool(Tool):
    """
    Find where a function/class is defined in the codebase.
    
    Gap Addressed: LLMs lose track of where things are defined.
    This finds exact locations.
    """
    
    @property
    def name(self) -> str:
        return "find_definition"
    
    @property
    def description(self) -> str:
        return (
            "Find where a function, class, or variable is defined "
            "in the codebase. Searches Python files for definitions."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "name": {
                "type": "string",
                "description": "Name of function, class, or variable to find",
            },
            "directory": {
                "type": "string",
                "description": "Directory to search (default: current dir)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["name"]
    
    async def execute(self, name: str, directory: str = ".") -> ToolResult:
        """Find the definition."""
        try:
            search_dir = Path(directory).resolve()
            results = []
            
            for py_file in search_dir.rglob("*.py"):
                # Skip common non-source directories
                if any(p in str(py_file) for p in [
                    "__pycache__", ".venv", "venv", "node_modules", 
                    "site-packages", ".git"
                ]):
                    continue
                
                try:
                    code = py_file.read_text(encoding="utf-8")
                    tree = ast.parse(code)
                    
                    for node in ast.walk(tree):
                        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            if node.name == name:
                                results.append({
                                    "type": "function",
                                    "file": str(py_file),
                                    "line": node.lineno,
                                    "docstring": ast.get_docstring(node) or "",
                                })
                        elif isinstance(node, ast.ClassDef):
                            if node.name == name:
                                results.append({
                                    "type": "class",
                                    "file": str(py_file),
                                    "line": node.lineno,
                                    "docstring": ast.get_docstring(node) or "",
                                })
                except:
                    continue
            
            if not results:
                return ToolResult.fail(f"No definition found for `{name}`")
            
            output = f"📍 **Found {len(results)} definition(s) for `{name}`:**\n\n"
            for r in results:
                rel_path = Path(r['file']).name
                output += f"- **{r['type'].title()}** in `{rel_path}` @ line {r['line']}\n"
                output += f"  Full path: `{r['file']}`\n"
                if r["docstring"]:
                    doc_preview = r["docstring"][:100].replace("\n", " ")
                    output += f"  Doc: {doc_preview}...\n"
            
            return ToolResult.ok(output, definitions=results)
            
        except Exception as e:
            return ToolResult.fail(f"Search failed: {e}")


class FindUsagesTool(Tool):
    """
    Find all usages of a function/class in the codebase.
    
    Gap Addressed: LLMs don't know where things are used.
    Changing a function? This shows what might break.
    """
    
    @property
    def name(self) -> str:
        return "find_usages"
    
    @property
    def description(self) -> str:
        return (
            "Find all places where a function, class, or variable is used. "
            "Useful before refactoring to see what might break."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "name": {
                "type": "string",
                "description": "Name to search for",
            },
            "directory": {
                "type": "string",
                "description": "Directory to search (default: current dir)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["name"]
    
    async def execute(self, name: str, directory: str = ".") -> ToolResult:
        """Find usages."""
        try:
            import re
            
            search_dir = Path(directory).resolve()
            usages = []
            
            # Pattern to match usage (word boundary)
            pattern = re.compile(rf'\b{re.escape(name)}\b')
            
            for py_file in search_dir.rglob("*.py"):
                if any(p in str(py_file) for p in [
                    "__pycache__", ".venv", "venv", "site-packages"
                ]):
                    continue
                
                try:
                    lines = py_file.read_text(encoding="utf-8").splitlines()
                    for i, line in enumerate(lines, 1):
                        if pattern.search(line):
                            # Skip definition lines
                            stripped = line.strip()
                            if not (stripped.startswith(("def ", "class ", "async def "))):
                                usages.append({
                                    "file": str(py_file),
                                    "line": i,
                                    "code": line.strip()[:80],
                                })
                except:
                    continue
            
            if not usages:
                return ToolResult.ok(f"No usages found for `{name}`")
            
            output = f"📍 **Found {len(usages)} usage(s) of `{name}`:**\n\n"
            
            # Group by file
            by_file = {}
            for u in usages:
                fname = Path(u["file"]).name
                if fname not in by_file:
                    by_file[fname] = []
                by_file[fname].append(u)
            
            for fname, file_usages in by_file.items():
                output += f"**{fname}:**\n"
                for u in file_usages[:5]:
                    output += f"  - Line {u['line']}: `{u['code'][:60]}`\n"
                if len(file_usages) > 5:
                    output += f"  - ... and {len(file_usages) - 5} more\n"
            
            return ToolResult.ok(output, usage_count=len(usages))
            
        except Exception as e:
            return ToolResult.fail(f"Search failed: {e}")


class RunTestsTool(Tool):
    """
    Run pytest tests.
    
    Gap Addressed: LLMs can't run tests to verify changes work.
    """
    
    @property
    def name(self) -> str:
        return "run_tests"
    
    @property
    def description(self) -> str:
        return (
            "Run pytest tests to verify code works correctly. "
            "Use after making changes to ensure nothing is broken."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "path": {
                "type": "string",
                "description": "Test file or directory (default: current dir)",
            },
            "pattern": {
                "type": "string",
                "description": "Only run tests matching this pattern",
            },
            "verbose": {
                "type": "boolean",
                "description": "Verbose output",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return []
    
    async def execute(
        self, 
        path: str = ".", 
        pattern: str = "",
        verbose: bool = False
    ) -> ToolResult:
        """Run the tests."""
        try:
            cmd = [sys.executable, "-m", "pytest", path, "-q"]
            if verbose:
                cmd.append("-v")
            if pattern:
                cmd.extend(["-k", pattern])
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), 
                    timeout=120
                )
            except asyncio.TimeoutError:
                process.kill()
                return ToolResult.fail("⏱️ Tests timed out after 120s")
            
            output = stdout.decode() if stdout else ""
            errors = stderr.decode() if stderr else ""
            
            if process.returncode == 0:
                return ToolResult.ok(f"✅ **Tests passed!**\n\n```\n{output}\n```")
            
            return ToolResult.fail(
                f"❌ **Tests failed!**\n\n```\n{output}\n{errors}\n```"
            )
            
        except Exception as e:
            return ToolResult.fail(f"Test run failed (is pytest installed?): {e}")


# Export tools for discovery
TOOLS = [
    AnalyzeCodeTool(),
    RunPythonTool(),
    RunPythonFileTool(),
    LintCodeTool(),
    FindDefinitionTool(),
    FindUsagesTool(),
    RunTestsTool(),
]
