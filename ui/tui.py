from rich.console import Console
from rich.theme import Theme
from rich.panel import Panel
from rich.markdown import Markdown
from rich.spinner import Spinner
from rich.live import Live
from rich.text import Text
from rich.rule import Rule
from rich.style import Style
from rich.syntax import Syntax
from rich.table import Table
from typing import Any
import json
import sys


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
        "tool.name": "bright_cyan bold",
        "tool.read": "cyan",
        "tool.write": "yellow",
        "tool.shell": "magenta",
        "tool.network": "bright_blue",
        "tool.memory": "green",
        "tool.mcp": "bright_cyan",
        # Code / blocks
        "code": "white",
        # Status
        "thinking": "dim italic",
        "streaming": "bright_green",
    }
)

# Tool icons for different tool types
TOOL_ICONS = {
    "read_file": "📄",
    "write_file": "✍️",
    "list_dir": "📁",
    "shell": "💻",
    "web_search": "🔍",
    "fetch_url": "🌐",
    "calculator": "🧮",
    "memory_store": "🧠",
    "memory_retrieve": "🧠",
    "default": "🔧",
}

# Language detection patterns for syntax highlighting
LANGUAGE_PATTERNS = {
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".json": "json",
    ".md": "markdown",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".html": "html",
    ".css": "css",
    ".sh": "bash",
    ".bash": "bash",
    ".sql": "sql",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".toml": "toml",
    ".xml": "xml",
    ".gitignore": "gitignore",
    ".env": "dotenv",
}

_console: Console | None = None


def get_console() -> Console:
    """Get or create the singleton console instance."""
    global _console
    if _console is None:
        _console = Console(theme=AGENT_THEME, highlight=False)
    return _console


def get_tool_icon(name: str) -> str:
    """Get the icon for a tool."""
    return TOOL_ICONS.get(name, TOOL_ICONS["default"])


def detect_language(file_path: str) -> str | None:
    """Detect programming language from file extension."""
    import os
    ext = os.path.splitext(file_path)[1].lower()
    name = os.path.basename(file_path).lower()
    
    # Check exact filename first
    if name in LANGUAGE_PATTERNS:
        return LANGUAGE_PATTERNS[name]
    
    # Then check extension
    return LANGUAGE_PATTERNS.get(ext)


class TUI:
    """Main terminal UI renderer using Rich."""

    def __init__(self, console: Console | None = None) -> None:
        self.console = console or get_console()
        self._streaming_buffer: str = ""
        self._is_streaming: bool = False
        self._live: Live | None = None

    def show_welcome(self) -> None:
        """Display welcome message."""
        self.console.print()
        self.console.print(
            Panel(
                "[bold cyan]🤖 Agentic CLI[/bold cyan]\n[dim]Your AI-powered terminal assistant[/dim]",
                border_style="cyan",
                padding=(1, 2),
            )
        )
        self.console.print()

    def show_user_message(self, message: str) -> None:
        """Display the user's input message in a panel."""
        self.console.print()
        self.console.print(
            Panel(
                Text(message, style="bright_white"),
                title="[user]👤 You[/user]",
                border_style="bright_blue",
                padding=(0, 1),
            )
        )
        self.console.print()

    def show_thinking(self) -> None:
        """Show a thinking indicator."""
        self.console.print(Text("🤔 Thinking...", style="thinking"))

    def start_assistant_response(self) -> None:
        """Start the assistant response section with live updating panel."""
        self._streaming_buffer = ""
        self._is_streaming = True
        # Start live display for real-time panel updates
        self._live = Live(
            self._render_response_panel(),
            console=self.console,
            refresh_per_second=10,
            transient=True,  # Will be replaced by final panel
        )
        self._live.start()

    def _render_response_panel(self) -> Panel:
        """Render the current response buffer as a panel."""
        content = self._streaming_buffer if self._streaming_buffer else "..."
        try:
            # Try to render as markdown
            md = Markdown(content)
            return Panel(
                md,
                title="[assistant]🤖 Assistant[/assistant]",
                border_style="green",
                padding=(0, 1),
            )
        except Exception:
            return Panel(
                content,
                title="[assistant]🤖 Assistant[/assistant]",
                border_style="green",
                padding=(0, 1),
            )

    def stream_assistant_delta(self, content: str) -> None:
        """Stream a text delta and update the live panel."""
        if not self._is_streaming:
            self.start_assistant_response()
        
        self._streaming_buffer += content
        
        # Update the live display
        if self._live:
            self._live.update(self._render_response_panel())

    def end_assistant_response(self) -> None:
        """End streaming and show final response in a panel."""
        if self._is_streaming:
            # Stop the live display
            if self._live:
                self._live.stop()
                self._live = None
            
            # Print the final panel (non-transient)
            self.console.print(self._render_response_panel())
            self.console.print()
            
            self._is_streaming = False

    def show_complete_response(self, content: str) -> None:
        """Display a complete response with markdown rendering."""
        self.console.print()
        try:
            md = Markdown(content)
            self.console.print(Panel(md, title="[assistant]Assistant[/assistant]", border_style="grey35"))
        except Exception:
            # Fallback to plain text if markdown fails
            self.console.print(Panel(content, title="[assistant]Assistant[/assistant]", border_style="grey35"))
        self.console.print()

    def show_error(self, error: str) -> None:
        """Display an error message."""
        # End any streaming first
        if self._is_streaming:
            self.end_assistant_response()
        self.console.print()
        self.console.print(
            Panel(
                f"[error]❌ Error:[/error] {error}",
                border_style="red",
                title="Error",
            )
        )
        self.console.print()

    def show_success(self, message: str) -> None:
        """Display a success message."""
        self.console.print(Text(f"✅ {message}", style="success"))

    def show_info(self, message: str) -> None:
        """Display an info message."""
        self.console.print(Text(f"ℹ️  {message}", style="info"))

    def show_separator(self) -> None:
        """Display a horizontal rule separator."""
        self.console.print(Rule(style="border"))

    def show_agent_start(self, message: str) -> None:
        """Show agent starting to process a message."""
        self.show_user_message(message)
        self.start_assistant_response()

    def show_agent_end(self) -> None:
        """Show agent finished processing."""
        self.end_assistant_response()
        self.console.print()
    
    # ==================== TOOL DISPLAY METHODS ====================
    
    def show_tool_call(self, name: str, arguments: dict[str, Any]) -> None:
        """Display that the LLM is calling a tool."""
        icon = get_tool_icon(name)
        
        # Format arguments nicely
        if arguments:
            args_text = json.dumps(arguments, indent=2)
            # Create syntax highlighted JSON
            try:
                args_display = Syntax(args_text, "json", theme="monokai", line_numbers=False)
            except Exception:
                args_display = Text(args_text, style="dim")
        else:
            args_display = Text("(no arguments)", style="dim")
        
        # Create the panel content
        content = Table.grid(padding=(0, 1))
        content.add_column(style="bold")
        content.add_column()
        content.add_row("Tool:", Text(name, style="tool.name"))
        content.add_row("Args:", args_display)
        
        self.console.print()
        self.console.print(
            Panel(
                content,
                title=f"[tool]{icon} Tool Call[/tool]",
                border_style="magenta",
                padding=(0, 1),
            )
        )
    
    def show_tool_executing(self, name: str) -> None:
        """Show that a tool is being executed."""
        icon = get_tool_icon(name)
        self.console.print(
            Text(f"  ⏳ Executing {icon} {name}...", style="thinking")
        )
    
    def show_tool_result(
        self,
        name: str,
        result: str,
        success: bool = True,
        context: dict[str, Any] | None = None,
    ) -> None:
        """Display the result of a tool execution.
        
        Args:
            name: Tool name
            result: Tool output
            success: Whether execution succeeded
            context: Optional context (e.g., file_path for read_file)
        """
        icon = get_tool_icon(name)
        context = context or {}
        
        # Truncate long results for display
        max_lines = 20
        result_lines = result.split('\n')
        total_lines = len(result_lines)
        truncated = False
        
        if total_lines > max_lines:
            display_result = '\n'.join(result_lines[:max_lines])
            display_result += f"\n... ({total_lines - max_lines} more lines)"
            truncated = True
        else:
            display_result = result
        
        if success:
            border_style = "green"
            title = f"[success]{icon} {name}[/success]"
            status_icon = "✅"
        else:
            border_style = "red"
            title = f"[error]{icon} {name} Failed[/error]"
            status_icon = "❌"
        
        # Build subtitle with context info
        subtitle_parts = [f"{status_icon} {'Success' if success else 'Failed'}"]
        if total_lines > 1:
            subtitle_parts.append(f"{total_lines} lines")
        if truncated:
            subtitle_parts.append("truncated")
        subtitle = " | ".join(subtitle_parts)
        
        # Try to detect and syntax highlight code based on tool type
        content: Any
        
        if name == "read_file" and display_result.strip():
            # Get file path from context for language detection
            file_path = context.get("file_path", context.get("path", ""))
            lang = detect_language(file_path) if file_path else None
            
            # Fallback to content-based detection if no extension
            if not lang:
                first_lines = display_result.strip()[:200]
                if first_lines.startswith(('def ', 'class ', 'import ', 'from ', 'async ')):
                    lang = "python"
                elif first_lines.startswith(('function ', 'const ', 'let ', 'var ', 'export ')):
                    lang = "javascript"
                elif first_lines.startswith('{') or first_lines.startswith('['):
                    lang = "json"
                elif first_lines.startswith('<!DOCTYPE') or first_lines.startswith('<html'):
                    lang = "html"
            
            if lang:
                try:
                    content = Syntax(
                        display_result, 
                        lang, 
                        theme="monokai", 
                        line_numbers=True,
                        word_wrap=True,
                    )
                    # Update title with file info
                    if file_path:
                        import os
                        title = f"[success]{icon} {os.path.basename(file_path)}[/success]"
                except Exception:
                    content = Text(display_result)
            else:
                content = Text(display_result)
                
        elif name == "list_dir":
            # Format directory listing nicely
            lines = []
            for line in display_result.strip().split('\n'):
                if line.endswith('/'):
                    lines.append(f"📁 {line}")
                else:
                    lines.append(f"📄 {line}")
            content = Text('\n'.join(lines))
            
        elif name == "shell":
            # Show shell output with command styling
            try:
                content = Syntax(display_result, "bash", theme="monokai", line_numbers=False)
            except Exception:
                content = Text(display_result, style="dim")
                
        elif name == "web_search":
            try:
                content = Markdown(display_result)
            except Exception:
                content = Text(display_result)
                
        elif name == "fetch_url":
            # Try to parse as markdown or show as text
            try:
                content = Markdown(display_result)
            except Exception:
                content = Text(display_result)
                
        elif name == "write_file":
            # Show confirmation message
            content = Text(display_result, style="success")
            
        else:
            content = Text(display_result)
        
        self.console.print(
            Panel(
                content,
                title=title,
                subtitle=f"[dim]{subtitle}[/dim]",
                border_style=border_style,
                padding=(0, 1),
            )
        )
        self.console.print()
    
    def show_tool_error(self, name: str, error: str) -> None:
        """Display a tool execution error."""
        self.show_tool_result(name, error, success=False)

    def show_interactive_welcome(self, persona: str, tools_enabled: bool) -> None:
        """Show welcome message for interactive mode."""
        self.console.print()
        self.console.print(
            Panel(
                "[bold cyan]🤖 Agentic CLI - Interactive Mode[/bold cyan]\n"
                "[dim]Your AI-powered terminal assistant with persistent context[/dim]",
                border_style="cyan",
                padding=(1, 2),
            )
        )
        self.console.print()
        self.console.print(f"  [dim]Persona:[/dim] [bold]{persona}[/bold]")
        if tools_enabled:
            self.console.print("  [dim]Tools:[/dim] [bold green]Enabled[/bold green]")
        self.console.print()

    def show_turn(self, turn: int, max_turns: int) -> None:
        """Display the current turn number in the agentic loop."""
        # Use different colors based on how many turns used
        if turn == 1:
            style = "dim italic"
            icon = "🔄"
        elif turn < max_turns * 0.5:
            style = "cyan italic"
            icon = "🔄"
        elif turn < max_turns * 0.8:
            style = "yellow italic"
            icon = "⚠️"
        else:
            style = "bright_red italic"
            icon = "🔴"
        
        self.console.print(
            Text(f"  {icon} Turn {turn}/{max_turns}", style=style)
        )
    
    def show_context_info(self, message_count: int, approx_tokens: int | None = None) -> None:
        """Display context window information."""
        info = f"📊 Context: {message_count} messages"
        if approx_tokens:
            info += f" (~{approx_tokens:,} tokens)"
        self.console.print(Text(info, style="dim"))
