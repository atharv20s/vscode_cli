from email import message
from http import client
from typing import Any
from Agent.agent import Agent
from Agent.events import AgentEventType
from CLIENT.LLMClient import LLMClient
import asyncio
import click
from ui.tui import get_console, TUI
console=get_console()

class CLI:
    def __init__(self):
        self.agent: Agent | None = None
        self.tui = TUI(console=console)


    async def run_single(self,message:str):
      async with Agent() as agent:
        self.agent=agent
        await self._process_message(message)


    async def _process_message(self, message: str) -> str | None:
    
      if not self.agent:
        return None
      async for event in self.agent.run(message):
        if event.type==AgentEventType.TEXT_DELTA:
          content=event.data.get("content","")
          self.tui.stream_assistant_delta(content)



async def run(messages: dict[str, Any]|None):
  client=LLMClient()
  async for event in client.chat_completion(messages,True):
    print(event)


@click.command() 
@click.argument("prompt", nargs=-1, required=False)

def main(
  prompt: tuple[str, ...] | None,
):
  message = " ".join(prompt) if prompt else None
  print(message)
  cli=CLI()
  # messages=[{
  #   "role":"user",
  #   "content":prompt
  # }]

  if message:
    asyncio.run(cli.run_single(message))


  

main()