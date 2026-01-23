from typing import Any
from Agent.agent import Agent
from Agent.events import AgentEventType
from CLIENT.LLMClient import LLMClient
import asyncio
import click
from ui.tui import get_console, TUI

console = get_console()


class CLI:
    """Main CLI controller for the Agentic CLI."""

    def __init__(self):
        self.agent: Agent | None = None
        self.tui = TUI(console=console)

    async def run_single(self, message: str) -> None:
        """Run a single message through the agent (single-shot mode)."""
        async with Agent() as agent:
            self.agent = agent
            await self._process_message(message)

    async def _process_message(self, message: str) -> str | None:
        """Process a message through the agent and stream the response."""
        if not self.agent:
            return None

        final_response: str | None = None

        async for event in self.agent.run(message):
            if event.type == AgentEventType.AGENT_START:
                # Show the user message and start streaming
                self.tui.show_agent_start(message)

            elif event.type == AgentEventType.TEXT_DELTA:
                # Stream each text chunk inline
                content = event.data.get("content", "")
                self.tui.stream_assistant_delta(content)

            elif event.type == AgentEventType.TEXT_COMPLETE:
                # Response complete - capture final text
                final_response = event.data.get("content", "")

            elif event.type == AgentEventType.AGENT_END:
                # Agent finished - close the response
                self.tui.show_agent_end()

            elif event.type == AgentEventType.AGENT_ERROR:
                # Show error message
                error = event.data.get("error", "Unknown error")
                self.tui.show_error(error)

        return final_response


@click.command()
@click.argument("prompt", nargs=-1, required=False)
@click.option("--welcome", "-w", is_flag=True, help="Show welcome message")
def main(prompt: tuple[str, ...] | None, welcome: bool) -> None:
    """Agentic CLI - Your AI-powered terminal assistant.
    
    Usage: python main.py "Your question or prompt here"
    """
    cli = CLI()

    # Show welcome banner if requested
    if welcome:
        cli.tui.show_welcome()

    # Join the prompt arguments into a single message
    message = " ".join(prompt) if prompt else None

    if message:
        # Run single mode - process one message and exit
        try:
            asyncio.run(cli.run_single(message))
        except KeyboardInterrupt:
            cli.tui.show_info("Interrupted by user")
        except Exception as e:
            cli.tui.show_error(f"Unexpected error: {str(e)}")
    else:
        # No message provided - show help
        cli.tui.show_info("No prompt provided. Usage: python main.py \"Your question here\"")
        cli.tui.show_info("Use --help for more options.")


if __name__ == "__main__":
    main()