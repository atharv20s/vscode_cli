from collections.abc import AsyncGenerator
from typing import Any
from CLIENT.response import StreamEventType, StreamEvent, TokenUsage
from openai import AsyncOpenAI, RateLimitError, APIConnectionError, APIError

from dataclasses import dataclass

@dataclass
class TextDelta:
    content: str


class LLMClient:
  def __init__(self):
    self.client: AsyncOpenAI | None = None
    self._max_retries: int = 4

    finish_reason: str | None = None

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


    for attempt in range(self._max_retries+1):
      try:
        
        if stream:
          async for event in self._stream_response(client, kwargs):
            yield event
        else:
          event = await anext(self._non_stream_response(client, kwargs))
        yield event
        return
      except RateLimitError as e:
        if attempt<self._max_retries:
          ##were holdin up by te eponential backoffs as in here
          wait_time=2**attempt
          await asyncio.sleep(wait_time)

        else:
          yield StreamEvent(
            type=StreamEventType.ERROR,
            error=f"Rate limit exceeded: {str(e)}",
          )
          return
      except APIConnectionError as e:
        if attempt<self._max_retries:
          wait_time=2**attempt
          await asyncio.sleep(wait_time)
        else:
          yield StreamEvent(
            type=StreamEventType.ERROR,
            error=f"API connection error: {str(e)}",
          )
          return

      except APIError as e:
        yield StreamEvent(
          type=StreamEventType.ERROR,
          error=f"API error: {str(e)}",
        )
        return
        # yield StreamEvent(
        #   type=EventType.ERROR,
        #   error=f"API connection error: {str(e)}",
        # )
        # return

      


  async def _stream_response(
    self,
    client: AsyncOpenAI,
    kwargs: dict[str, Any],
  )-> AsyncGenerator[StreamEvent, None]:
    response = await client.chat.completions.create(**kwargs)


    usage:TokenUsage|None


    async for chunk in response:
      if hasattr(chunk, 'usage') and chunk.usage:
        usage=TokenUsage(
          prompt_tokens=chunk.usage.prompt_tokens,
          completion_tokens=chunk.usage.completion_tokens,
          total_tokens=chunk.usage.total_tokens,
          cached_tokens=getattr(chunk.usage.prompt_tokens_details, 'cached_tokens', 0),
        )
      if not chunk.choices:
        continue  

      choice=chunk.choices[0]
      text_delta=None

      if choice.finish_reason:
        finish_reason=choice.finish_reason

      delta = choice.delta  # stream payload contains incremental delta
      if delta and delta.content:
        yield StreamEvent(
          type=StreamEventType.TEXT_DELTA,
          text_delta=TextDelta(delta.content),

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
      
