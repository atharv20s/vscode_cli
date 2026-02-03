"""
Terminal User Interface for the Agentic CLI.

Provides rich console output with:
- Themed styling for different elements
- Tool call visualization
- Confirmation dialogs
- Help display
"""

from pathlib import Path
from typing import Any
from rich.console import Console
from rich.theme import Theme
from rich.rule import Rule
from rich.text import Text
from rich.panel import Panel
from rich.table import Table
from rich import box
from rich.prompt import Prompt
from rich.console import Group
from rich.syntax import Syntax
from rich.markdown import Markdown
from config.config import Config
from tools.base import ToolConfirmation
from utils.paths import display_path_rel_to_cwd
import re

from utils.text import truncate_text

AGENT_THEME = Theme(
    {
        # General
        "info": "cyan",
        "warning": "yellow",
        "error": "bright_red bold",
        "success": "green",
        "dim": "dim",
        "muted": "grey50",
        "border": "grey35",
        "highlight": "bold cyan",
        # Roles
        "user": "bright_blue bold",
        "assistant": "bright_white",
        # Tools
        "tool": "bright_magenta bold",
        "tool.read": "cyan",
        "tool.write": "yellow",
        "tool.shell": "magenta",
        "tool.network": "bright_blue",
        "tool.memory": "green",
        # Code / blocks
        "code": "white",
    }
)

_console: Console | None = None


def get_console() -> Console:
    global _console
    if _console is None:
        _console = Console(theme=AGENT_THEME, highlight=False)

    return _console


class TUI:
    def __init__(
        self,
        config: Config,
        console: Console | None = None,
    ) -> None:
        self.console = console or get_console()
        self._assistant_stream_open = False
        self._thinking_open = False
        self._thinking_content = ""
        self._tool_args_by_call_id: dict[str, dict[str, Any]] = {}
        self.config = config
        self.cwd = self.config.cwd
        self._max_block_tokens = 2500

    # === Chain of Thought Display ===
    def begin_thinking(self, topic: str = "") -> None:
        """Start displaying chain of thought reasoning."""
        self.console.print()
        title = "🧠 Thinking" + (f": {topic}" if topic else "...")
        self.console.print(Panel.fit(
            Text(title, style="dim italic cyan"),
            border_style="dim cyan",
            box=box.ROUNDED,
        ))
        self._thinking_open = True
        self._thinking_content = ""

    def stream_thinking_delta(self, content: str) -> None:
        """Stream thinking content."""
        if self._thinking_open:
            self.console.print(content, end="", style="dim italic", markup=False)
            self._thinking_content += content

    def end_thinking(self, summary: str = "") -> None:
        """End chain of thought display."""
        if self._thinking_open:
            self.console.print()  # End the streaming line
            if summary:
                self.console.print(f"[dim]💡 Insight: {summary}[/dim]")
            self.console.print()
        self._thinking_open = False

    def show_plan(self, steps: list[str]) -> None:
        """Display a plan with numbered steps."""
        table = Table(
            title="📋 Plan",
            box=box.ROUNDED,
            border_style="cyan",
            show_header=False,
            padding=(0, 1),
        )
        table.add_column("Step", style="bold cyan", width=4)
        table.add_column("Action", style="white")
        
        for i, step in enumerate(steps, 1):
            table.add_row(f"{i}.", step)
        
        self.console.print()
        self.console.print(table)
        self.console.print()

    def show_reasoning_step(self, step: int, title: str, content: str) -> None:
        """Display a single reasoning step."""
        self.console.print(
            Panel(
                Text(content, style="dim"),
                title=f"[cyan]Step {step}:[/cyan] {title}",
                title_align="left",
                border_style="dim",
                box=box.SIMPLE,
            )
        )

    def begin_assistant(self) -> None:
        self.console.print()
        self.console.print(Rule(Text("Assistant", style="assistant")))
        self._assistant_stream_open = True

    def end_assistant(self) -> None:
        if self._assistant_stream_open:
            self.console.print()
        self._assistant_stream_open = False

    def stream_assistant_delta(self, content: str) -> None:
        self.console.print(content, end="", markup=False)

    def _ordered_args(self, tool_name: str, args: dict[str, Any]) -> list[tuple]:
        _PREFERRED_ORDER = {
            "read_file": ["path", "offset", "limit"],
            "write_file": ["path", "create_directories", "content"],
            "edit": ["path", "replace_all", "old_string", "new_string"],
            "shell": ["command", "timeout", "cwd"],
            "list_dir": ["path", "include_hidden"],
            "grep": ["path", "case_insensitive", "pattern"],
            "glob": ["path", "pattern"],
            "todos": ["id", "action", "content"],
            "memory": ["action", "key", "value"],
        }

        preferred = _PREFERRED_ORDER.get(tool_name, [])
        ordered: list[tuple[str, Any]] = []
        seen = set()

        for key in preferred:
            if key in args:
                ordered.append((key, args[key]))
                seen.add(key)

        remaining_keys = set(args.keys() - seen)
        ordered.extend((key, args[key]) for key in remaining_keys)

        return ordered

    def _render_args_table(self, tool_name: str, args: dict[str, Any]) -> Table:
        table = Table.grid(padding=(0, 1))
        table.add_column(style="muted", justify="right", no_wrap=True)
        table.add_column(style="code", overflow="fold")

        for key, value in self._ordered_args(tool_name, args):
            if isinstance(value, str):
                if key in {"content", "old_string", "new_string"}:
                    line_count = len(value.splitlines()) or 0
                    byte_count = len(value.encode("utf-8", errors="replace"))
                    value = f"<{line_count} lines - {byte_count} bytes>"

            if isinstance(value, bool):
                value = str(value)

            table.add_row(key, value)

        return table

    def tool_call_start(
        self,
        call_id: str,
        name: str,
        tool_kind: str | None,
        arguments: dict[str, Any],
    ) -> None:
        self._tool_args_by_call_id[call_id] = arguments
        border_style = f"tool.{tool_kind}" if tool_kind else "tool"

        title = Text.assemble(
            ("* ", "muted"),
            (name, "tool"),
            ("  ", "muted"),
            (f"#{call_id[:8]}", "muted"),
        )

        display_args = dict(arguments)
        for key in ("path", "cwd"):
            val = display_args.get(key)
            if isinstance(val, str) and self.cwd:
                display_args[key] = str(display_path_rel_to_cwd(val, self.cwd))

        panel = Panel(
            (
                self._render_args_table(name, display_args)
                if display_args
                else Text(
                    "(no args)",
                    style="muted",
                )
            ),
            title=title,
            title_align="left",
            subtitle=Text("running", style="muted"),
            subtitle_align="right",
            border_style=border_style,
            box=box.ROUNDED,
            padding=(1, 2),
        )
        self.console.print()
        self.console.print(panel)

    def _extract_read_file_code(self, text: str) -> tuple[int, str] | None:
        body = text
        header_match = re.match(r"^Showing lines (\d+)-(\d+) of (\d+)\n\n", text)

        if header_match:
            body = text[header_match.end() :]

        code_lines: list[str] = []
        start_line: int | None = None

        for line in body.splitlines():
            # 1|def main():
            # 2| print()
            m = re.match(r"^\s*(\d+)\|(.*)$", line)
            if not m:
                return None
            line_no = int(m.group(1))
            if start_line is None:
                start_line = line_no
            code_lines.append(m.group(2))

        if start_line is None:
            return None

        return start_line, "\n".join(code_lines)

    def _guess_language(self, path: str | None) -> str:
        if not path:
            return "text"
        suffix = Path(path).suffix.lower()
        return {
            ".py": "python",
            ".js": "javascript",
            ".jsx": "jsx",
            ".ts": "typescript",
            ".tsx": "tsx",
            ".json": "json",
            ".toml": "toml",
            ".yaml": "yaml",
            ".yml": "yaml",
            ".md": "markdown",
            ".sh": "bash",
            ".bash": "bash",
            ".zsh": "bash",
            ".rs": "rust",
            ".go": "go",
            ".java": "java",
            ".kt": "kotlin",
            ".swift": "swift",
            ".c": "c",
            ".h": "c",
            ".cpp": "cpp",
            ".hpp": "cpp",
            ".css": "css",
            ".html": "html",
            ".xml": "xml",
            ".sql": "sql",
        }.get(suffix, "text")

    def print_welcome(self, title: str, lines: list[str]) -> None:
        body = "\n".join(lines)
        self.console.print(
            Panel(
                Text(body, style="code"),
                title=Text(title, style="highlight"),
                title_align="left",
                border_style="border",
                box=box.ROUNDED,
                padding=(1, 2),
            )
        )

    def tool_call_complete(
        self,
        call_id: str,
        name: str,
        tool_kind: str | None,
        success: bool,
        output: str,
        error: str | None,
        metadata: dict[str, Any] | None,
        diff: str | None,
        truncated: bool,
        exit_code: int | None,
    ) -> None:
        border_style = f"tool.{tool_kind}" if tool_kind else "tool"
        status_icon = "[OK]" if success else "[X]"
        status_style = "success" if success else "error"

        title = Text.assemble(
            (f"{status_icon} ", status_style),
            (name, "tool"),
            ("  ", "muted"),
            (f"#{call_id[:8]}", "muted"),
        )

        args = self._tool_args_by_call_id.get(call_id, {})

        primary_path = None
        blocks = []
        if isinstance(metadata, dict) and isinstance(metadata.get("path"), str):
            primary_path = metadata.get("path")

        if name == "read_file" and success:
            if primary_path:
                parsed = self._extract_read_file_code(output)
                if parsed:
                    start_line, code = parsed
                else:
                    start_line, code = 1, output

                shown_start = metadata.get("shown_start") if metadata else None
                shown_end = metadata.get("shown_end") if metadata else None
                total_lines = metadata.get("total_lines") if metadata else None
                pl = self._guess_language(primary_path)

                header_parts = [display_path_rel_to_cwd(primary_path, self.cwd)]
                header_parts.append(" - ")

                if shown_start and shown_end and total_lines:
                    header_parts.append(
                        f"lines {shown_start}-{shown_end} of {total_lines}"
                    )

                header = "".join(header_parts)
                blocks.append(Text(header, style="muted"))
                blocks.append(
                    Syntax(
                        code,
                        pl,
                        theme="monokai",
                        line_numbers=True,
                        start_line=start_line,
                        word_wrap=False,
                    )
                )
            else:
                output_display = truncate_text(
                    output,
                    "",
                    self._max_block_tokens,
                )
                blocks.append(
                    Syntax(
                        output_display,
                        "text",
                        theme="monokai",
                        word_wrap=False,
                    )
                )
        elif name in {"write_file", "edit"} and success and diff:
            output_line = output.strip() if output.strip() else "Completed"
            blocks.append(Text(output_line, style="muted"))
            diff_text = diff
            diff_display = truncate_text(
                diff_text,
                self.config.model_name,
                self._max_block_tokens,
            )
            blocks.append(
                Syntax(
                    diff_display,
                    "diff",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        elif name == "shell" and success:
            command = args.get("command")
            if isinstance(command, str) and command.strip():
                blocks.append(Text(f"$ {command.strip()}", style="muted"))

            if exit_code is not None:
                blocks.append(Text(f"exit_code={exit_code}", style="muted"))

            output_display = truncate_text(
                output,
                self.config.model_name,
                self._max_block_tokens,
            )
            blocks.append(
                Syntax(
                    output_display,
                    "text",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        elif name == "list_dir" and success:
            entries = metadata.get("entries") if metadata else None
            path = metadata.get("path") if metadata else None
            summary = []
            if isinstance(path, str):
                summary.append(path)

            if isinstance(entries, int):
                summary.append(f"{entries} entries")

            if summary:
                blocks.append(Text(" - ".join(summary), style="muted"))

            output_display = truncate_text(
                output,
                self.config.model_name,
                self._max_block_tokens,
            )
            blocks.append(
                Syntax(
                    output_display,
                    "text",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        elif name == "grep" and success:
            matches = metadata.get("matches") if metadata else None
            files_searched = metadata.get("files_searched") if metadata else None
            summary = []
            if isinstance(matches, int):
                summary.append(f"{matches} matches")
            if isinstance(files_searched, int):
                summary.append(f"searched {files_searched} files")

            if summary:
                blocks.append(Text(" - ".join(summary), style="muted"))

            output_display = truncate_text(
                output, self.config.model_name, self._max_block_tokens
            )
            blocks.append(
                Syntax(
                    output_display,
                    "text",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        elif name == "glob" and success:
            matches = metadata.get("matches") if metadata else None
            if isinstance(matches, int):
                blocks.append(Text(f"{matches} matches", style="muted"))

            output_display = truncate_text(
                output,
                self.config.model_name,
                self._max_block_tokens,
            )
            blocks.append(
                Syntax(
                    output_display,
                    "text",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        elif name == "web_search" and success:
            results = metadata.get("results") if metadata else None
            query = args.get("query")
            summary = []
            if isinstance(query, str):
                summary.append(query)
            if isinstance(results, int):
                summary.append(f"{results} results")

            if summary:
                blocks.append(Text(" - ".join(summary), style="muted"))

            output_display = truncate_text(
                output,
                self.config.model_name,
                self._max_block_tokens,
            )
            blocks.append(
                Syntax(
                    output_display,
                    "text",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        elif name == "web_fetch" and success:
            status_code = metadata.get("status_code") if metadata else None
            content_length = metadata.get("content_length") if metadata else None
            url = args.get("url")
            summary = []
            if isinstance(status_code, int):
                summary.append(str(status_code))
            if isinstance(content_length, int):
                summary.append(f"{content_length} bytes")
            if isinstance(url, str):
                summary.append(url)

            if summary:
                blocks.append(Text(" - ".join(summary), style="muted"))

            output_display = truncate_text(
                output,
                self.config.model_name,
                self._max_block_tokens,
            )
            blocks.append(
                Syntax(
                    output_display,
                    "text",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        elif name == "todos" and success:
            output_display = truncate_text(
                output,
                self.config.model_name,
                self._max_block_tokens,
            )
            blocks.append(
                Syntax(
                    output_display,
                    "text",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        elif name == "memory" and success:
            action = args.get("action")
            key = args.get("key")
            found = metadata.get("found") if metadata else None
            summary = []
            if isinstance(action, str) and action:
                summary.append(action)
            if isinstance(key, str) and key:
                summary.append(key)
            if isinstance(found, bool):
                summary.append("found" if found else "missing")

            if summary:
                blocks.append(Text(" - ".join(summary), style="muted"))
            output_display = truncate_text(
                output,
                self.config.model_name,
                self._max_block_tokens,
            )
            blocks.append(
                Syntax(
                    output_display,
                    "text",
                    theme="monokai",
                    word_wrap=True,
                )
            )
        else:
            if error and not success:
                blocks.append(Text(error, style="error"))

            output_display = truncate_text(
                output, self.config.model_name, self._max_block_tokens
            )
            if output_display.strip():
                blocks.append(
                    Syntax(
                        output_display,
                        "text",
                        theme="monokai",
                        word_wrap=True,
                    )
                )
            else:
                blocks.append(Text("(no output)", style="muted"))

        if truncated:
            blocks.append(Text("note: tool output was truncated", style="warning"))

        panel = Panel(
            Group(
                *blocks,
            ),
            title=title,
            title_align="left",
            subtitle=Text("done" if success else "failed", style=status_style),
            subtitle_align="right",
            border_style=border_style,
            box=box.ROUNDED,
            padding=(1, 2),
        )
        self.console.print()
        self.console.print(panel)

    def handle_confirmation(self, confirmation: ToolConfirmation) -> bool:
        output = [
            Text(confirmation.tool_name, style="tool"),
            Text(confirmation.description, style="code"),
        ]

        if confirmation.command:
            output.append(Text(f"$ {confirmation.command}", style="warning"))

        if confirmation.diff:
            diff_text = confirmation.diff.to_diff()
            output.append(
                Syntax(
                    diff_text,
                    "diff",
                    theme="monokai",
                    word_wrap=True,
                )
            )

        self.console.print()
        self.console.print(
            Panel(
                Group(*output),
                title=Text("Approval required", style="warning"),
                title_align="left",
                border_style="warning",
                box=box.ROUNDED,
                padding=(1, 2),
            )
        )

        response = Prompt.ask(
            "\nApprove?", choices=["y", "n", "yes", "no"], default="n"
        )

        return response.lower() in {"y", "yes"}

    def show_help(self) -> None:
        help_text = """
## Commands

- `/help` - Show this help
- `/exit` or `/quit` - Exit the agent
- `/clear` - Clear conversation history
- `/config` - Show current configuration
- `/model <name>` - Change the model
- `/approval <mode>` - Change approval mode
- `/stats` - Show session statistics
- `/tools` - List available tools
- `/save` - Save current session
- `/checkpoint [name]` - Create a checkpoint
- `/checkpoints` - List available checkpoints
- `/restore <checkpoint_id>` - Restore a checkpoint
- `/sessions` - List saved sessions
- `/resume <session_id>` - Resume a saved session

## Tips

- Just type your message to chat with the agent
- The agent can read, write, and execute code
- Some operations require approval (can be configured)
"""
        self.console.print(Markdown(help_text))

    def print_info(self, message: str) -> None:
        """Print an info message."""
        self.console.print(f"[info]{message}[/info]")

    def print_warning(self, message: str) -> None:
        """Print a warning message."""
        self.console.print(f"[warning]{message}[/warning]")

    def print_error(self, message: str) -> None:
        """Print an error message."""
        self.console.print(f"[error]{message}[/error]")

    def print_success(self, message: str) -> None:
        """Print a success message."""
        self.console.print(f"[success]{message}[/success]")

    # Aliases for main.py compatibility
    def show_info(self, message: str) -> None:
        """Show an info message (alias for print_info)."""
        self.print_info(message)
    
    def show_warning(self, message: str) -> None:
        """Show a warning message (alias for print_warning)."""
        self.print_warning(message)
    
    def show_error(self, message: str) -> None:
        """Show an error message (alias for print_error)."""
        self.print_error(message)
    
    def show_success(self, message: str) -> None:
        """Show a success message (alias for print_success)."""
        self.print_success(message)
    
    def show_user_message(self, message: str) -> None:
        """Display a user message."""
        self.console.print()
        self.console.print(Rule(Text("User", style="user")))
        self.console.print(message)
    
    def show_agent_start(self, message: str) -> None:
        """Show that agent is starting to process."""
        pass  # Silent - begin_assistant handles the display
    
    def show_agent_end(self) -> None:
        """Show that agent has finished."""
        pass  # Silent - end_assistant handles this
    
    def start_assistant_response(self) -> None:
        """Start streaming assistant response."""
        self.begin_assistant()
    
    def end_assistant_response(self) -> None:
        """End streaming assistant response."""
        self.end_assistant()
    
    def show_interactive_welcome(self, persona: str, tools_enabled: bool) -> None:
        """Show welcome message for interactive mode."""
        self.console.print(Panel.fit(
            f"[bold cyan]Agentic CLI[/bold cyan] - Interactive Mode\n"
            f"Persona: [bold]{persona}[/bold] | Tools: [bold]{'enabled' if tools_enabled else 'disabled'}[/bold]",
            border_style="cyan"
        ))
    
    def show_context_info(self, msg_count: int, approx_tokens: int) -> None:
        """Show context information."""
        self.console.print(f"[info]Messages: {msg_count} | Approx tokens: {approx_tokens}[/info]")
    # Additional aliases for main.py compatibility
    def show_tool_call(self, name: str, arguments: dict[str, Any]) -> None:
        """Show a tool call (alias for tool_call_start)."""
        # Generate a call_id and infer tool_kind from name
        import uuid
        call_id = str(uuid.uuid4())[:8]
        tool_kind = self._infer_tool_kind(name)
        self.tool_call_start(call_id, name, tool_kind, arguments)
    
    def _infer_tool_kind(self, name: str) -> str:
        """Infer tool kind from tool name for styling."""
        read_tools = {"read_file", "list_dir", "glob", "grep"}
        write_tools = {"write_file", "edit"}
        shell_tools = {"shell"}
        network_tools = {"web_search", "fetch"}
        memory_tools = {"memory", "todos"}
        
        if name in read_tools:
            return "read"
        elif name in write_tools:
            return "write"
        elif name in shell_tools:
            return "shell"
        elif name in network_tools:
            return "network"
        elif name in memory_tools:
            return "memory"
        return "tool"
    
    def show_tool_executing(self, name: str) -> None:
        """Show that a tool is executing."""
        self.console.print(f"[dim]Executing {name}...[/dim]")
    
    def show_tool_result(self, name: str, result: str, success: bool = True, context: Any = None) -> None:
        """Show tool result (alias for tool_call_complete)."""
        import uuid
        call_id = str(uuid.uuid4())[:8]
        tool_kind = self._infer_tool_kind(name)
        
        # Extract metadata from context if provided
        metadata = None
        if isinstance(context, dict):
            metadata = context
        
        self.tool_call_complete(
            call_id=call_id,
            name=name,
            tool_kind=tool_kind,
            success=success,
            output=result if success else "",
            error=result if not success else None,
            metadata=metadata,
            diff=None,
            truncated=False,
            exit_code=None,
        )
    
    def show_tool_error(self, name: str, error: str) -> None:
        """Show a tool error."""
        self.console.print(f"[error]Tool {name} failed: {error}[/error]")
    
    def show_turn(self, turn: int, max_turns: int) -> None:
        """Show the current turn number."""
        self.console.print(f"[dim]Turn {turn}/{max_turns}[/dim]")