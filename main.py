"""
Agentic CLI - Your AI-powered terminal assistant.

Usage:
    python main.py "Your question here"
    python main.py -p coder "Write a function"
    python main.py -w "Hello"  # with welcome banner
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

    def __init__(self, persona: str = "default", system_prompt: str | None = None):
        self.agent: Agent | None = None
        self.tui = TUI(console=console)
        self.persona = persona
        self.system_prompt = system_prompt

    async def run_single(self, message: str) -> None:
        """Run a single message through the agent (single-shot mode)."""
        async with Agent(
            system_prompt=self.system_prompt,
            persona=self.persona,
        ) as agent:
            self.agent = agent
            await self._process_message(message)

    async def _process_message(self, message: str) -> str | None:
        """Process a message through the agent and stream the response."""
        if not self.agent:
            return None

        final_response: str | None = None

        async for event in self.agent.run(message):
            if event.type == AgentEventType.AGENT_START:
                self.tui.show_agent_start(message)

            elif event.type == AgentEventType.TEXT_DELTA:
                content = event.data.get("content", "")
                self.tui.stream_assistant_delta(content)

            elif event.type == AgentEventType.TEXT_COMPLETE:
                final_response = event.data.get("content", "")

            elif event.type == AgentEventType.AGENT_END:
                self.tui.show_agent_end()

            elif event.type == AgentEventType.AGENT_ERROR:
                error = event.data.get("error", "Unknown error")
                self.tui.show_error(error)

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
@click.option("--list-personas", is_flag=True, help="List available personas")
def main(
    prompt: tuple[str, ...] | None,
    welcome: bool,
    persona: str,
    system: str | None,
    list_personas: bool,
) -> None:
    """Agentic CLI - Your AI-powered terminal assistant.
    
    Examples:
        python main.py "Explain Python decorators"
        python main.py -p coder "Write a sorting function"
        python main.py -s "You are a pirate" "Tell me about ships"
    """
    tui = TUI(console=console)
    
    if list_personas:
        tui.show_info("Available Personas:")
        for name, prompt_text in SYSTEM_PROMPTS.items():
            console.print(f"\n[bold cyan]{name}[/bold cyan]")
            first_line = prompt_text.strip().split("\n")[0]
            console.print(f"  [dim]{first_line}[/dim]")
        return

    cli = CLI(persona=persona, system_prompt=system)

    if welcome:
        cli.tui.show_welcome()
        if system:
            cli.tui.show_info("Using custom system prompt")
        else:
            cli.tui.show_info(f"Persona: {persona}")

    message = " ".join(prompt) if prompt else None

    if message:
        try:
            asyncio.run(cli.run_single(message))
        except KeyboardInterrupt:
            cli.tui.show_info("Interrupted by user")
        except Exception as e:
            cli.tui.show_error(f"Unexpected error: {str(e)}")
    else:
        cli.tui.show_info("No prompt provided. Usage: python main.py \"Your question here\"")
        cli.tui.show_info("Use --help for more options.")
        cli.tui.show_info("Use --list-personas to see available AI personas.")


if __name__ == "__main__":
    main()