"""
LLM Client for OpenRouter/OpenAI API communication with multi-model support.
"""

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Any
from dataclasses import dataclass

from openai import AsyncOpenAI, RateLimitError, APIConnectionError, APIError

from CLIENT.response import StreamEventType, StreamEvent, TokenUsage, TextDelta, ToolCallDelta
from config.settings import get_settings


class LLMClient:
    """Async LLM client with streaming support, tool calling, and retry logic."""
    
    def __init__(self, model: str | None = None):
        """Initialize LLM client.
        
        Args:
            model: Optional model override. If None, uses settings default.
        """
        self.client: AsyncOpenAI | None = None
        self._max_retries: int = 4
        self._settings = get_settings()
        self._model_override = model
        
        # Resolve model and provider
        self._resolved_model: str = self._settings.model
        self._resolved_base_url: str = self._settings.api_base_url
        self._resolved_api_key: str = self._settings.api_key
        
        if model:
            self._resolve_model_config(model)
    
    def _resolve_model_config(self, model: str) -> None:
        """Resolve model configuration from models registry."""
        try:
            from config.models import get_model, PROVIDERS, LLMProvider
            
            model_config = get_model(model)
            if model_config:
                self._resolved_model = model_config.model_id
                provider_config = PROVIDERS.get(model_config.provider)
                
                if provider_config:
                    self._resolved_base_url = provider_config.base_url
                    # Use environment variable for API key based on provider
                    import os
                    env_key = provider_config.env_key
                    env_api_key = os.environ.get(env_key)
                    if env_api_key:
                        self._resolved_api_key = env_api_key
            else:
                # Model name not in registry, use as-is (direct model ID)
                self._resolved_model = model
        except ImportError:
            # Fallback if models.py not available
            self._resolved_model = model

    def get_client(self) -> AsyncOpenAI:
        """Get or create the AsyncOpenAI client."""
        if self.client is None:
            self.client = AsyncOpenAI(
                api_key=self._resolved_api_key,
                base_url=self._resolved_base_url,
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
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Send a chat completion request to the LLM.
        
        Args:
            messages: List of message dicts with 'role' and 'content'
            stream: Whether to stream the response
            tools: Optional list of tool definitions (OpenAI function format)
            
        Yields:
            StreamEvent objects for text deltas, tool calls, completion, or errors
        """
        client = self.get_client()
        kwargs: dict[str, Any] = {
            "model": self._resolved_model,
            "messages": messages,
            "stream": stream,
        }
        
        # Add tools if provided
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

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
        """Handle streaming API response with tool call support."""
        response = await client.chat.completions.create(**kwargs)
        usage: TokenUsage | None = None
        
        # Accumulate tool calls across chunks
        tool_calls_acc: dict[int, dict[str, str]] = {}

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
            
            # Handle text content
            if choice.delta and choice.delta.content:
                yield StreamEvent(
                    type=StreamEventType.TEXT_DELTA,
                    text_delta=TextDelta(choice.delta.content),
                )
            
            # Handle tool calls (accumulate across chunks)
            if choice.delta and choice.delta.tool_calls:
                for tc in choice.delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls_acc:
                        tool_calls_acc[idx] = {
                            "id": "",
                            "name": "",
                            "arguments": "",
                        }
                    
                    if tc.id:
                        tool_calls_acc[idx]["id"] = tc.id
                    if tc.function and tc.function.name:
                        tool_calls_acc[idx]["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        tool_calls_acc[idx]["arguments"] += tc.function.arguments
            
            # Check if we're done
            if choice.finish_reason == "tool_calls":
                # Emit all accumulated tool calls
                tool_call_deltas = [
                    ToolCallDelta(
                        id=tc["id"],
                        name=tc["name"],
                        arguments=tc["arguments"],
                    )
                    for tc in tool_calls_acc.values()
                ]
                yield StreamEvent(
                    type=StreamEventType.TOOL_CALL,
                    tool_calls=tool_call_deltas,
                    finish_reason="tool_calls",
                )

    async def _non_stream_response(
        self,
        client: AsyncOpenAI,
        kwargs: dict[str, Any],
    ) -> AsyncGenerator[StreamEvent, None]:
        """Handle non-streaming API response with tool call support."""
        response = await client.chat.completions.create(**kwargs)

        choice = response.choices[0]
        message = choice.message
        
        # Parse usage
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
        
        # Check for tool calls
        if message.tool_calls:
            tool_call_deltas = [
                ToolCallDelta(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=tc.function.arguments,
                )
                for tc in message.tool_calls
            ]
            yield StreamEvent(
                type=StreamEventType.TOOL_CALL,
                tool_calls=tool_call_deltas,
                finish_reason=choice.finish_reason,
                usage=usage,
            )
        elif message.content:
            yield StreamEvent(
                type=StreamEventType.MESSAGE_COMPLETE,
                text_delta=TextDelta(content=message.content),
                finish_reason=choice.finish_reason,
                usage=usage,
            )
