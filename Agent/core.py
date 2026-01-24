"""
Core Agent implementation with async context manager and tool calling support.
"""

from __future__ import annotations

import json
from typing import AsyncGenerator, Any
from Agent.events import AgentEvent, AgentEventType, ToolCall
from CLIENT.response import StreamEventType
from CLIENT.llm import LLMClient
from prompts.system import get_system_prompt
from tools import setup_tools, ToolRegistry, get_registry
from config.settings import get_settings, load_agents_md


class Agent:
    """
    Async Context Manager Agent for managing LLM conversations with tool support.
    
    Usage:
        async with Agent(persona="coder", tools_enabled=True) as agent:
            async for event in agent.run("Read main.py and summarize it"):
                print(event)
    
    The agent will:
    1. Send messages to the LLM with available tools
    2. Execute tool calls when the LLM requests them
    3. Return results to the LLM for final response
    4. Stream the final response
    """

    def __init__(
        self,
        system_prompt: str | None = None,
        persona: str = "default",
        tools_enabled: bool = True,
        max_iterations: int | None = None,
    ):
        """Initialize the Agent.
        
        Args:
            system_prompt: Custom system prompt (overrides persona)
            persona: Preset persona name (default, coder, teacher, analyst, creative)
            tools_enabled: Whether to enable tool calling
            max_iterations: Max tool calling loops (default from settings)
        """
        self.settings = get_settings()
        self.client: LLMClient | None = None
        self.messages: list[dict[str, Any]] = []
        self.current_message: str = ""
        self._is_initialized: bool = False
        self.tools_enabled = tools_enabled
        self.registry: ToolRegistry | None = None
        self.current_turn: int = 0
        
        # Use settings for max iterations if not specified
        self.max_iterations = max_iterations or self.settings.max_iterations
        
        # Set system prompt - custom takes priority over persona
        if system_prompt:
            self.system_prompt = system_prompt
        else:
            self.system_prompt = get_system_prompt(persona)

    async def __aenter__(self) -> Agent:
        """Async context manager entry - initialize resources."""
        self.client = LLMClient()
        self._is_initialized = True
        
        # Setup tools if enabled
        if self.tools_enabled:
            self.registry = setup_tools()
        
        # Build system prompt
        system_content = self.system_prompt
        
        # Load AGENTS.md if enabled
        if self.settings.load_agents_md:
            agents_md = load_agents_md(self.settings.agents_md_path)
            if agents_md:
                system_content += f"\n\n## Custom Instructions from AGENTS.md:\n{agents_md}"
        
        # Add tool instructions if enabled
        if self.tools_enabled and self.registry:
            tool_names = self.registry.list_tools()
            system_content += f"\n\nYou have access to the following tools: {', '.join(tool_names)}. Use them when needed to help answer questions."
        
        self.messages = [{"role": "system", "content": system_content}]
        
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit - cleanup resources."""
        if self.client:
            await self.client.close()
            self.client = None
        self._is_initialized = False

    def _ensure_initialized(self) -> None:
        """Ensure the agent is properly initialized via context manager."""
        if not self._is_initialized:
            raise RuntimeError(
                "Agent must be used as async context manager: "
                "'async with Agent() as agent:'"
            )

    def _get_tool_schemas(self) -> list[dict[str, Any]] | None:
        """Get tool schemas for the LLM if tools are enabled."""
        if self.tools_enabled and self.registry:
            return self.registry.get_definitions()
        return None

    async def run(self, message: str) -> AsyncGenerator[AgentEvent, None]:
        """Run the agent with a user message.
        
        Args:
            message: The user's input message
            
        Yields:
            AgentEvent: Events for agent lifecycle, streaming, and tool calls
        """
        self._ensure_initialized()
        
        self.current_message = message
        # Add user message to conversation history
        self.messages.append({"role": "user", "content": message})
        
        yield AgentEvent.agent_start(message)
        
        final_response: str | None = None
        
        # Run the agentic loop (may include multiple LLM calls for tool use)
        async for event in self._agentic_loop():
            yield event

            if event.type == AgentEventType.TEXT_COMPLETE:
                final_response = event.data.get("content", "")
                # Add assistant response to conversation history
                if final_response:
                    self.messages.append({"role": "assistant", "content": final_response})
                break
            
            elif event.type == AgentEventType.AGENT_ERROR:
                # Stop on error
                break

        yield AgentEvent.agent_end(final_response)

    async def _agentic_loop(self) -> AsyncGenerator[AgentEvent, None]:
        """
        Core agentic loop with tool calling support.
        
        Flow:
        1. Send messages to LLM (with tools if enabled)
        2. If LLM returns text → stream it and complete
        3. If LLM returns tool_calls → execute tools, add results, loop back to 1
        """
        self.current_turn = 0
        response_text = ""
        
        while self.current_turn < self.max_iterations:
            self.current_turn += 1
            response_text = ""
            pending_tool_calls: list[ToolCall] = []
            
            # Emit turn start event (only if we have tools and past turn 1)
            if self.tools_enabled and self.current_turn > 1:
                yield AgentEvent.turn_start(self.current_turn, self.max_iterations)
            
            # Get tool schemas if enabled
            tool_schemas = self._get_tool_schemas()
            
            # Call LLM
            async for event in self.client.chat_completion(
                self.messages,
                stream=True,
                tools=tool_schemas,
            ):
                if event.type == StreamEventType.TEXT_DELTA:
                    content = event.text_delta.content
                    response_text += content
                    yield AgentEvent.text_delta(content)
                    
                elif event.type == StreamEventType.TOOL_CALL:
                    # LLM wants to call tools
                    for tc in event.tool_calls:
                        try:
                            args = json.loads(tc.arguments) if tc.arguments else {}
                        except json.JSONDecodeError:
                            args = {}
                        
                        tool_call = ToolCall(
                            id=tc.id,
                            name=tc.name,
                            arguments=args,
                        )
                        pending_tool_calls.append(tool_call)
                        yield AgentEvent.tool_call(tool_call)
                        
                elif event.type == StreamEventType.ERROR:
                    yield AgentEvent.agent_error(event.error or "Unknown error")
                    return
            
            # If we got text (no tool calls), we're done
            if response_text and not pending_tool_calls:
                yield AgentEvent.text_complete(response_text)
                return
            
            # If we have tool calls, execute them
            if pending_tool_calls:
                # Add assistant message with tool calls
                self.messages.append({
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.arguments),
                            }
                        }
                        for tc in pending_tool_calls
                    ]
                })
                
                # Execute each tool and add results
                for tc in pending_tool_calls:
                    yield AgentEvent.tool_executing(tc.name, tc.arguments)
                    
                    # Execute the tool
                    result = await self.registry.execute(tc.name, **tc.arguments)
                    
                    if result.success:
                        yield AgentEvent.tool_result(
                            tool_id=tc.id,
                            name=tc.name,
                            result=result.output,
                            success=True,
                        )
                        tool_content = result.output
                    else:
                        yield AgentEvent.tool_error(
                            tool_id=tc.id,
                            name=tc.name,
                            error=result.error or "Unknown error",
                        )
                        tool_content = f"Error: {result.error}"
                    
                    # Add tool result message
                    self.messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": tool_content,
                    })
                
                # Continue loop to get LLM's response after tool results
                continue
            
            # No response and no tool calls - something went wrong
            if not response_text:
                yield AgentEvent.agent_error("No response from LLM")
                return
        
        # Max iterations reached
        yield AgentEvent.agent_error(f"Max iterations ({self.max_iterations}) reached")
