"""
Builtin tools that come with the Agentic CLI.

Available Tools (27):
- Filesystem: read_file, write_file, edit_file, list_dir
- Search: grep, glob
- Shell: shell
- Web: web_search, fetch_url
- Code Intelligence: analyze_code, run_python, run_python_file, lint_code,
                     find_definition, find_usages, run_tests
- Git: git_status, git_diff, git_log, git_commit, git_branch, git_checkout
- Memory: remember, recall, list_memories, forget, summarize_session
"""

from tools.builtin.shell import ShellTool
from tools.builtin.filesystem import ReadFileTool, WriteFileTool, EditFileTool, ListDirTool
from tools.builtin.web import WebSearchTool, FetchURLTool
from tools.builtin.search import GrepTool, GlobTool

# Code Intelligence Tools - Better than Claude/GPT!
from tools.builtin.code_intel import (
    AnalyzeCodeTool,
    RunPythonTool,
    RunPythonFileTool,
    LintCodeTool,
    FindDefinitionTool,
    FindUsagesTool,
    RunTestsTool,
)

# Git Tools - Version control awareness
from tools.builtin.git_tools import (
    GitStatusTool,
    GitDiffTool,
    GitLogTool,
    GitCommitTool,
    GitBranchTool,
    GitCheckoutTool,
)

# Memory Tools - Persistent memory across sessions
from tools.builtin.memory_tools import (
    RememberTool,
    RecallTool,
    ListMemoriesTool,
    ForgetTool,
    SummarizeSessionTool,
)

__all__ = [
    # Filesystem
    "ShellTool",
    "ReadFileTool",
    "WriteFileTool",
    "EditFileTool",
    "ListDirTool",
    # Web
    "WebSearchTool",
    "FetchURLTool",
    # Search
    "GrepTool",
    "GlobTool",
    # Code Intelligence
    "AnalyzeCodeTool",
    "RunPythonTool",
    "RunPythonFileTool",
    "LintCodeTool",
    "FindDefinitionTool",
    "FindUsagesTool",
    "RunTestsTool",
    # Git
    "GitStatusTool",
    "GitDiffTool",
    "GitLogTool",
    "GitCommitTool",
    "GitBranchTool",
    "GitCheckoutTool",
    # Memory
    "RememberTool",
    "RecallTool",
    "ListMemoriesTool",
    "ForgetTool",
    "SummarizeSessionTool",
]
