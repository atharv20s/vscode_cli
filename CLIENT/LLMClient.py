from collections.abc import AsyncGenerator
from typing import Any
from CLIENT.response import EventType, StreamEvent, TokenUsage
from openai import AsyncOpenAI

from dataclasses import dataclass

@dataclass
class TextDelta:
    content: str


class LLMClient:
  def __init__(self):
    self.client: AsyncOpenAI | None = None

  def get_client(self) -> AsyncOpenAI:
    if self.client is None:
      self.client = AsyncOpenAI(
        api_key="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",
        base_url="https://openrouter.ai/api/v1",
      )
    return self.client

  async def close(self) -> None:
    if self.client:
      await self.client.close()
      self.client = None

  async def chat_completion(
    self,
    messages: list[dict[str, Any]],
    stream: bool = True,
  ) -> AsyncGenerator[StreamEvent, None]:
    
    client = self.get_client()
    kwargs = {
      "model": "mistralai/devstral-2512:free",
      "messages": messages,
      "stream": stream,
    }
    if stream:
      async for event in self._stream_response(client, kwargs):
        yield event
    else:
      event = await anext(self._non_stream_response(client, kwargs))
    yield event


  async def _stream_response(
    self,
    client: AsyncOpenAI,
    kwargs: dict[str, Any],
  )-> AsyncGenerator[StreamEvent, None]:
    response = await client.chat.completions.create(**kwargs)
    async for chunk in response:
      if hasattr(chunk, 'usage') and chunk.usage:
        usage=TokenUsage(
          prompt_tokens=response.usage.prompt_tokens,
          completion_tokens=response.usage.completion_tokens,
          total_tokens=response.usage.total_tokens,
          cached_tokens=getattr(response.usage.prompt_tokens_details, 'cached_tokens', 0),
        )
      #yield chunk


  async def _non_stream_response(
    self,
    client: AsyncOpenAI,
    kwargs: dict[str, Any],
  ) -> StreamEvent | None:
    response = await client.chat.completions.create(**kwargs)

    async for chunk in response:
      yield chunk


    choice=response.choices[0]
    message=choice.message
    text_delta=None
    if message.content:
      text_delta=TextDelta(content=message.content)
    usage=None
    if response.usage:
      usage=TokenUsage(
        prompt_tokens=response.usage.prompt_tokens,
        completion_tokens=response.usage.completion_tokens,
        total_tokens=response.usage.total_tokens,
        cached_tokens=getattr(response.usage.prompt_tokens_details, 'cached_tokens', 0),
      )

      yield StreamEvent(
        type=EventType.MESSAGE_COMPLETE,
        text_delta=text_delta,
        finish_reason=choice.finish_reason,
        usage=usage,
      )


    print(response)
      
