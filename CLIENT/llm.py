"""
LLM Client for OpenRouter/OpenAI API communication.
"""

import asyncio
from collections.abc import AsyncGenerator
from typing import Any
from dataclasses import dataclass

from openai import AsyncOpenAI, RateLimitError, APIConnectionError, APIError

from CLIENT.response import StreamEventType, StreamEvent, TokenUsage
from config.settings import get_settings


@dataclass
class TextDelta:
    """Represents a text delta from streaming response."""
    content: str


class LLMClient:
    """Async LLM client with streaming support and retry logic."""
    
    def __init__(self):
        self.client: AsyncOpenAI | None = None
        self._max_retries: int = 4
        self._settings = get_settings()

    def get_client(self) -> AsyncOpenAI:
        """Get or create the AsyncOpenAI client."""
        if self.client is None:
            self.client = AsyncOpenAI(
                api_key=self._settings.api_key,
                base_url=self._settings.api_base_url,
            )
        return self.client

    async def close(self) -> None:
        """Close the HTTP client connection."""
        if self.client:
            await self.client.close()
            self.client = None

    async def chat_completion(
        self,
        messages: list[dict[str, Any]],
        stream: bool = True,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Send a chat completion request to the LLM.
        
        Args:
            messages: List of message dicts with 'role' and 'content'
            stream: Whether to stream the response
            
        Yields:
            StreamEvent objects for text deltas, completion, or errors
        """
        client = self.get_client()
        kwargs = {
            "model": self._settings.model,
            "messages": messages,
            "stream": stream,
        }

        for attempt in range(self._max_retries + 1):
            try:
                if stream:
                    async for event in self._stream_response(client, kwargs):
                        yield event
                else:
                    async for event in self._non_stream_response(client, kwargs):
                        yield event
                return
                
            except RateLimitError as e:
                if attempt < self._max_retries:
                    wait_time = 2 ** attempt
                    await asyncio.sleep(wait_time)
                else:
                    yield StreamEvent(
                        type=StreamEventType.ERROR,
                        error=f"Rate limit exceeded: {str(e)}",
                    )
                    return
                    
            except APIConnectionError as e:
                if attempt < self._max_retries:
                    wait_time = 2 ** attempt
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

    async def _stream_response(
        self,
        client: AsyncOpenAI,
        kwargs: dict[str, Any],
    ) -> AsyncGenerator[StreamEvent, None]:
        """Handle streaming API response."""
        response = await client.chat.completions.create(**kwargs)
        usage: TokenUsage | None = None

        async for chunk in response:
            if hasattr(chunk, 'usage') and chunk.usage:
                usage = TokenUsage(
                    prompt_tokens=chunk.usage.prompt_tokens,
                    completion_tokens=chunk.usage.completion_tokens,
                    total_tokens=chunk.usage.total_tokens,
                    cached_tokens=getattr(
                        chunk.usage.prompt_tokens_details, 'cached_tokens', 0
                    ) if hasattr(chunk.usage, 'prompt_tokens_details') else 0,
                )
                
            if not chunk.choices:
                continue

            choice = chunk.choices[0]

            if choice.delta and choice.delta.content:
                yield StreamEvent(
                    type=StreamEventType.TEXT_DELTA,
                    text_delta=TextDelta(choice.delta.content),
                )

    async def _non_stream_response(
        self,
        client: AsyncOpenAI,
        kwargs: dict[str, Any],
    ) -> AsyncGenerator[StreamEvent, None]:
        """Handle non-streaming API response."""
        response = await client.chat.completions.create(**kwargs)

        choice = response.choices[0]
        message = choice.message
        text_delta = None
        
        if message.content:
            text_delta = TextDelta(content=message.content)
        
        usage = None
        if response.usage:
            usage = TokenUsage(
                prompt_tokens=response.usage.prompt_tokens,
                completion_tokens=response.usage.completion_tokens,
                total_tokens=response.usage.total_tokens,
                cached_tokens=getattr(
                    response.usage.prompt_tokens_details, 'cached_tokens', 0
                ) if response.usage.prompt_tokens_details else 0,
            )

        yield StreamEvent(
            type=StreamEventType.MESSAGE_COMPLETE,
            text_delta=text_delta,
            finish_reason=choice.finish_reason,
            usage=usage,
        )
