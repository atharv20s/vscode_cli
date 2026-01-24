"""
Agentic CLI - Your AI-powered terminal assistant with tool calling.

Usage:
    python main.py "Your question here"
    python main.py -p coder "Write a function"
    python main.py -w "Hello"  # with welcome banner
    python main.py -t "Read main.py and summarize"  # with tools enabled
    python main.py -i  # interactive mode (REPL)
"""

from typing import Any
import asyncio
import click

from Agent.core import Agent
from Agent.events import AgentEventType
from prompts import SYSTEM_PROMPTS
from ui import TUI, get_console

console = get_console()


class CLI:
    """Main CLI controller for the Agentic CLI."""

    def __init__(
        self,
        persona: str = "default",
        system_prompt: str | None = None,
        tools_enabled: bool = False,
    ):
        self.agent: Agent | None = None
        self.tui = TUI(console=console)
        self.persona = persona
        self.system_prompt = system_prompt
        self.tools_enabled = tools_enabled
        self._running = False  # Track if interactive mode is running

    async def run_single(self, message: str) -> None:
        """Run a single message through the agent (single-shot mode)."""
        async with Agent(
            system_prompt=self.system_prompt,
            persona=self.persona,
            tools_enabled=self.tools_enabled,
        ) as agent:
            self.agent = agent
            await self._process_message(message)

    async def run_interactive(self) -> None:
        """Run interactive mode (REPL) with persistent context."""
        self._running = True
        
        async with Agent(
            system_prompt=self.system_prompt,
            persona=self.persona,
            tools_enabled=self.tools_enabled,
        ) as agent:
            self.agent = agent
            
            self.tui.show_interactive_welcome(self.persona, self.tools_enabled)
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
                        self.tui.show_info(f"Conversation context: {msg_count} messages")
                        console.print()
                        continue
                    
                    if lower_input == "/tools":
                        # Show available tools
                        if self.tools_enabled and agent.registry:
                            tools = agent.registry.list_tools()
                            self.tui.show_info(f"Available tools: {', '.join(tools)}")
                        else:
                            self.tui.show_info("Tools are disabled. Use -t flag to enable.")
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
  [bold]/help[/bold], [bold]/?[/bold]       - Show this help
  [bold]exit[/bold], [bold]quit[/bold]      - Exit interactive mode

[bold cyan]Tips:[/bold cyan]
  • Conversation context is preserved between messages
  • Use /clear to start a fresh conversation
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
                self.tui.show_tool_result(name, result, success)
            
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
    type=click.Choice(["default", "coder", "teacher", "analyst", "creative", "terminal", "concise"]),
    default="default",
    help="AI persona to use"
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
def main(
    prompt: tuple[str, ...] | None,
    welcome: bool,
    persona: str,
    system: str | None,
    tools: bool,
    interactive: bool,
    list_personas: bool,
) -> None:
    """Agentic CLI - Your AI-powered terminal assistant.
    
    Examples:
        python main.py "Explain Python decorators"
        python main.py -p coder "Write a sorting function"
        python main.py -t "Read main.py and summarize it"
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

    cli = CLI(persona=persona, system_prompt=system, tools_enabled=tools)

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