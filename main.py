"""
Agentic CLI - Your AI-powered terminal assistant with tool calling.

Usage:
    python main.py "Your question here"
    python main.py -p coder "Write a function"
    python main.py -w "Hello"  # with welcome banner
    python main.py -t "Read main.py and summarize"  # with tools enabled
    python main.py -i  # interactive mode (REPL)
    python main.py -m plan "Design a REST API"  # Plan mode - think first
    python main.py -m think "Complex problem"  # Deep reasoning mode
    python main.py --model gpt-4o "Question"  # Use specific model
    python main.py --list-models  # Show available models
"""

from typing import Any
import asyncio
import click
import os

from Agent.core import Agent
from Agent.events import AgentEventType
from Agent.modes import AgentMode, get_mode_config, get_all_modes
from prompts import SYSTEM_PROMPTS
from ui import TUI, get_console
from context.memory import ProjectMemory
from config.models import MODELS, get_model

console = get_console()

# Initialize project memory
try:
    memory = ProjectMemory(os.getcwd())
except Exception:
    memory = None


class CLI:
    """Main CLI controller for the Agentic CLI."""

    def __init__(
        self,
        persona: str = "default",
        system_prompt: str | None = None,
        tools_enabled: bool = False,
        mode: str = "agent",
        model: str | None = None,
    ):
        self.agent: Agent | None = None
        self.tui = TUI(console=console)
        self.persona = persona
        self.system_prompt = system_prompt
        self.tools_enabled = tools_enabled
        self.mode = mode
        self.model = model
        self._running = False  # Track if interactive mode is running
        
        # Apply mode settings
        self._apply_mode_settings()
    
    def _apply_mode_settings(self) -> None:
        """Apply mode-specific settings."""
        try:
            mode_enum = AgentMode(self.mode.upper())
            config = get_mode_config(mode_enum)
            
            # Mode can override tools_enabled (e.g., ASK mode disables tools)
            if not config.tools_enabled:
                self.tools_enabled = False
            
            # Add mode-specific addon to system prompt if exists
            if config.system_prompt_addon and self.system_prompt is None:
                base_prompt = SYSTEM_PROMPTS.get(self.persona, SYSTEM_PROMPTS["default"])
                self.system_prompt = base_prompt + "\n\n" + config.system_prompt_addon
                
        except (ValueError, KeyError):
            pass  # Use defaults if mode not recognized

    async def run_single(self, message: str) -> None:
        """Run a single message through the agent (single-shot mode)."""
        # Build memory context if available
        memory_context = ""
        if memory:
            memory_context = memory.generate_context_prompt()
        
        # Prepend memory to system prompt if we have it
        effective_prompt = self.system_prompt
        if memory_context and effective_prompt:
            effective_prompt = effective_prompt + "\n\n" + memory_context
        elif memory_context:
            effective_prompt = memory_context
        
        async with Agent(
            system_prompt=effective_prompt,
            persona=self.persona,
            tools_enabled=self.tools_enabled,
            model=self.model,
        ) as agent:
            self.agent = agent
            await self._process_message(message)

    async def run_interactive(self) -> None:
        """Run interactive mode (REPL) with persistent context."""
        self._running = True
        
        # Build memory context
        memory_context = ""
        if memory:
            memory_context = memory.generate_context_prompt()
        
        effective_prompt = self.system_prompt
        if memory_context and effective_prompt:
            effective_prompt = effective_prompt + "\n\n" + memory_context
        elif memory_context:
            effective_prompt = memory_context
        
        async with Agent(
            system_prompt=effective_prompt,
            persona=self.persona,
            tools_enabled=self.tools_enabled,
            model=self.model,
        ) as agent:
            self.agent = agent
            
            self.tui.show_interactive_welcome(self.persona, self.tools_enabled)
            self.tui.show_info(f"Mode: {self.mode.upper()} | Model: {self.model or 'default'}")
            self.tui.show_info("Type 'exit' or 'quit' to leave. '/help' for commands.")
            console.print()
            
            while self._running:
                try:
                    # Get user input with prompt
                    user_input = console.input("[bold cyan]You >[/bold cyan] ").strip()
                    
                    if not user_input:
                        continue
                    
                    # Handle special commands
                    lower_input = user_input.lower()
                    
                    if lower_input in ("exit", "quit", "/exit", "/quit"):
                        self.tui.show_info("Goodbye! 👋")
                        break
                    
                    if lower_input in ("/clear", "/reset"):
                        # Reset conversation context (keep system prompt)
                        system_msg = agent.messages[0] if agent.messages else None
                        agent.messages = [system_msg] if system_msg else []
                        self.tui.show_success("Context cleared. Starting fresh conversation.")
                        console.print()
                        continue
                    
                    if lower_input in ("/help", "/?"):
                        self._show_interactive_help()
                        continue
                    
                    if lower_input == "/context":
                        # Show conversation context size
                        msg_count = len(agent.messages) - 1  # Exclude system prompt
                        # Estimate tokens (rough: ~4 chars per token)
                        total_chars = sum(len(str(m.get("content", ""))) for m in agent.messages)
                        approx_tokens = total_chars // 4
                        self.tui.show_context_info(msg_count, approx_tokens)
                        console.print()
                        continue
                    
                    if lower_input == "/tools":
                        # Show available tools
                        if self.tools_enabled and agent.registry:
                            tools = agent.registry.list_tools()
                            self.tui.show_info(f"Available tools ({len(tools)}): {', '.join(tools)}")
                        else:
                            self.tui.show_info("Tools are disabled. Use -t flag to enable.")
                        console.print()
                        continue
                    
                    if lower_input == "/memory":
                        # Show memory info
                        if memory:
                            entries = memory.list_all()
                            self.tui.show_info(f"Memory entries: {len(entries)}")
                            for entry in entries[:5]:  # Show last 5
                                console.print(f"  • [{entry.category}] {entry.content[:50]}...")
                        else:
                            self.tui.show_info("Memory not available")
                        console.print()
                        continue
                    
                    if lower_input.startswith("/remember "):
                        # Quick remember
                        content = user_input[10:].strip()
                        if memory and content:
                            memory.remember(content, category="user_note")
                            self.tui.show_success(f"Remembered: {content[:50]}...")
                        console.print()
                        continue
                    
                    if lower_input == "/mode":
                        # Show current mode
                        self.tui.show_info(f"Current mode: {self.mode.upper()}")
                        self.tui.show_info("Available modes: ask, edit, agent, plan, think, debug, review")
                        console.print()
                        continue
                    
                    # Process the message
                    await self._process_message(user_input)
                    console.print()  # Add spacing between exchanges
                    
                except KeyboardInterrupt:
                    console.print()  # Newline after ^C
                    self.tui.show_info("Press Ctrl+C again to exit, or type a message.")
                    try:
                        continue
                    except KeyboardInterrupt:
                        self.tui.show_info("Goodbye! 👋")
                        break
                except EOFError:
                    # Handle Ctrl+D
                    console.print()
                    self.tui.show_info("Goodbye! 👋")
                    break
                except Exception as e:
                    self.tui.show_error(f"Error: {str(e)}")
                    continue
    
    def _show_interactive_help(self) -> None:
        """Show help for interactive mode."""
        help_text = """
[bold cyan]Interactive Mode Commands:[/bold cyan]

  [bold]/clear[/bold], [bold]/reset[/bold]  - Clear conversation context
  [bold]/context[/bold]        - Show conversation message count
  [bold]/tools[/bold]          - List available tools
  [bold]/memory[/bold]         - Show stored memories
  [bold]/remember <text>[/bold] - Store a memory
  [bold]/mode[/bold]           - Show current mode info
  [bold]/help[/bold], [bold]/?[/bold]       - Show this help
  [bold]exit[/bold], [bold]quit[/bold]      - Exit interactive mode

[bold cyan]Agent Modes:[/bold cyan]
  • [bold]ask[/bold]    - Questions only, no file changes
  • [bold]edit[/bold]   - Targeted file edits
  • [bold]agent[/bold]  - Full autonomous mode (default)
  • [bold]plan[/bold]   - Think before acting
  • [bold]think[/bold]  - Deep reasoning mode
  • [bold]debug[/bold]  - Debugging specialist
  • [bold]review[/bold] - Code review mode

[bold cyan]Tips:[/bold cyan]
  • Conversation context is preserved between messages
  • Use /clear to start a fresh conversation
  • Memory persists across sessions
  • Press Ctrl+C twice to force exit
"""
        console.print(help_text)

    async def _process_message(self, message: str) -> str | None:
        """Process a message through the agent and stream the response."""
        if not self.agent:
            return None

        final_response: str | None = None
        streaming_started = False

        async for event in self.agent.run(message):
            if event.type == AgentEventType.AGENT_START:
                self.tui.show_user_message(message)

            elif event.type == AgentEventType.TEXT_DELTA:
                # Start streaming panel if not already started
                if not streaming_started:
                    self.tui.start_assistant_response()
                    streaming_started = True
                content = event.data.get("content", "")
                self.tui.stream_assistant_delta(content)

            elif event.type == AgentEventType.TEXT_COMPLETE:
                final_response = event.data.get("content", "")

            elif event.type == AgentEventType.AGENT_END:
                if streaming_started:
                    self.tui.end_assistant_response()

            elif event.type == AgentEventType.AGENT_ERROR:
                if streaming_started:
                    self.tui.end_assistant_response()
                error = event.data.get("error", "Unknown error")
                self.tui.show_error(error)
            
            # Tool events
            elif event.type == AgentEventType.TOOL_CALL:
                # Stop any streaming before showing tool call
                if streaming_started:
                    self.tui.end_assistant_response()
                    streaming_started = False
                name = event.data.get("name", "unknown")
                arguments = event.data.get("arguments", {})
                self.tui.show_tool_call(name, arguments)
            
            elif event.type == AgentEventType.TOOL_EXECUTING:
                name = event.data.get("name", "unknown")
                self.tui.show_tool_executing(name)
            
            elif event.type == AgentEventType.TOOL_RESULT:
                name = event.data.get("name", "unknown")
                result = event.data.get("result", "")
                success = event.data.get("success", True)
                # Pass context for enhanced display (e.g., file path)
                context = event.data.get("context", {})
                self.tui.show_tool_result(name, result, success, context)
            
            elif event.type == AgentEventType.TOOL_ERROR:
                name = event.data.get("name", "unknown")
                error = event.data.get("error", "Unknown error")
                self.tui.show_tool_error(name, error)
            
            # Turn tracking
            elif event.type == AgentEventType.TURN_START:
                turn = event.data.get("turn", 1)
                max_turns = event.data.get("max_turns", 10)
                self.tui.show_turn(turn, max_turns)

        return final_response


@click.command()
@click.argument("prompt", nargs=-1, required=False)
@click.option("--welcome", "-w", is_flag=True, help="Show welcome message")
@click.option(
    "--persona", "-p",
    type=click.Choice([
        "default", "coder", "teacher", "analyst", "creative", 
        "terminal", "concise", "elite_coder", "debugger", "refactor"
    ]),
    default="default",
    help="AI persona to use (elite_coder, debugger, refactor are powerful coding personas)"
)
@click.option(
    "--mode", "-m",
    type=click.Choice(["ask", "edit", "agent", "plan", "think", "debug", "review"]),
    default="agent",
    help="Agent mode: ask (read-only), edit (targeted), agent (full), plan (think first), think (deep reasoning)"
)
@click.option(
    "--model",
    type=str,
    default=None,
    help="Model to use (e.g., gpt-4o, claude-sonnet, devstral). Use --list-models to see options."
)
@click.option(
    "--system", "-s",
    type=str,
    default=None,
    help="Custom system prompt (overrides persona)"
)
@click.option("--tools", "-t", is_flag=True, help="Enable tool calling (read_file, shell, web_search, etc.)")
@click.option("--interactive", "-i", is_flag=True, help="Run in interactive mode (REPL with persistent context)")
@click.option("--list-personas", is_flag=True, help="List available personas")
@click.option("--list-models", is_flag=True, help="List available models")
@click.option("--list-modes", is_flag=True, help="List available agent modes")
def main(
    prompt: tuple[str, ...] | None,
    welcome: bool,
    persona: str,
    mode: str,
    model: str | None,
    system: str | None,
    tools: bool,
    interactive: bool,
    list_personas: bool,
    list_models: bool,
    list_modes: bool,
) -> None:
    """Agentic CLI - Your AI-powered terminal assistant.
    
    Examples:
        python main.py "Explain Python decorators"
        python main.py -p coder "Write a sorting function"
        python main.py -t "Read main.py and summarize it"
        python main.py -m plan "Design a REST API"
        python main.py -m think "Complex algorithm problem"
        python main.py --model gpt-4o "Use GPT-4o for this"
        python main.py -s "You are a pirate" "Tell me about ships"
        python main.py -i  # Interactive mode
        python main.py -i -t  # Interactive mode with tools
    """
    tui = TUI(console=console)
    
    if list_personas:
        tui.show_info("Available Personas:")
        for name, prompt_text in SYSTEM_PROMPTS.items():
            console.print(f"\n[bold cyan]{name}[/bold cyan]")
            first_line = prompt_text.strip().split("\n")[0]
            console.print(f"  [dim]{first_line}[/dim]")
        return
    
    if list_models:
        tui.show_info("Available Models:")
        for model_id, model_config in MODELS.items():
            provider = model_config.provider.value
            console.print(f"\n[bold cyan]{model_id}[/bold cyan] ({provider})")
            console.print(f"  [dim]{model_config.display_name} - Context: {model_config.context_window:,} tokens[/dim]")
            console.print(f"  Best for: {', '.join(model_config.best_for)}")
            if model_config.cost_per_1k_input == 0:
                console.print(f"  [green]FREE[/green]")
        return
    
    if list_modes:
        tui.show_info("Available Agent Modes:")
        for mode_info in get_all_modes():
            console.print(f"\n[bold cyan]{mode_info.mode.value.lower()}[/bold cyan]")
            console.print(f"  {mode_info.description}")
            console.print(f"  [dim]Tools: {'✓' if mode_info.tools_enabled else '✗'} | Max iterations: {mode_info.max_iterations}[/dim]")
        return

    cli = CLI(
        persona=persona,
        system_prompt=system,
        tools_enabled=tools,
        mode=mode,
        model=model,
    )

    if welcome:
        cli.tui.show_welcome()
        if system:
            cli.tui.show_info("Using custom system prompt")
        else:
            cli.tui.show_info(f"Persona: {persona}")
        if tools:
            cli.tui.show_info("🛠️  Tools enabled: read_file, write_file, list_dir, shell, web_search")

    message = " ".join(prompt) if prompt else None

    # Interactive mode
    if interactive:
        try:
            asyncio.run(cli.run_interactive())
        except KeyboardInterrupt:
            cli.tui.show_info("Goodbye! 👋")
        except Exception as e:
            cli.tui.show_error(f"Unexpected error: {str(e)}")
        return

    # Single message mode
    if message:
        try:
            asyncio.run(cli.run_single(message))
        except KeyboardInterrupt:
            cli.tui.show_info("Interrupted by user")
        except Exception as e:
            cli.tui.show_error(f"Unexpected error: {str(e)}")
    else:
        cli.tui.show_info("No prompt provided. Usage: python main.py \"Your question here\"")
        cli.tui.show_info("Use -i for interactive mode (REPL with context)")
        cli.tui.show_info("Use --help for more options.")
        cli.tui.show_info("Use -t to enable tool calling (read files, run commands, search web)")


if __name__ == "__main__":
    main()