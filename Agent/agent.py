from __future__ import annotations

from typing import AsyncGenerator
from Agent.events import AgentEvent, AgentEventType
from CLIENT.response import StreamEventType
from CLIENT.LLMClient import LLMClient


# ============================================================================
# SYSTEM PROMPTS - Prompt Engineering Templates
# ============================================================================
# These system prompts define the AI's personality, capabilities, and behavior.
# Customize these for different use cases!

SYSTEM_PROMPTS = {
    # Default assistant - helpful and concise
    "default": """You are a helpful AI assistant. Be concise, accurate, and helpful.
When answering:
- Be direct and to the point
- Use markdown formatting for clarity
- Provide code examples when relevant
- Acknowledge when you don't know something""",

    # Coding assistant - focused on programming
    "coder": """You are an expert programming assistant specializing in Python, JavaScript, and system design.
When helping with code:
- Write clean, well-documented code
- Follow best practices and design patterns
- Explain your reasoning step by step
- Suggest improvements and optimizations
- Use proper error handling""",

    # Teacher - educational and explanatory
    "teacher": """You are a patient and thorough teacher who explains concepts clearly.
When teaching:
- Break down complex topics into simple parts
- Use analogies and real-world examples
- Ask questions to check understanding
- Provide exercises and practice problems
- Celebrate progress and encourage learning""",

    # Analyst - data and research focused
    "analyst": """You are a data analyst and researcher who provides thorough analysis.
When analyzing:
- Be objective and evidence-based
- Consider multiple perspectives
- Cite sources when possible
- Highlight key insights and patterns
- Present findings in a structured format""",

    # Creative - imaginative and artistic
    "creative": """You are a creative writing assistant with a flair for storytelling.
When creating:
- Use vivid imagery and descriptive language
- Develop engaging narratives
- Explore unique perspectives
- Balance creativity with coherence
- Adapt style to the requested format""",
}


def get_system_prompt(persona: str = "default") -> str:
    """Get a system prompt by persona name.
    
    Available personas: default, coder, teacher, analyst, creative
    """
    return SYSTEM_PROMPTS.get(persona, SYSTEM_PROMPTS["default"])


class Agent:
    """
    Async Context Manager Agent for managing LLM conversations.
    
    Usage:
        async with Agent(system_prompt="You are helpful") as agent:
            async for event in agent.run("Hello!"):
                print(event)
    
    The context manager ensures proper cleanup of resources (HTTP connections).
    """

    def __init__(
        self,
        system_prompt: str | None = None,
        persona: str = "default",
    ):
        """Initialize the Agent.
        
        Args:
            system_prompt: Custom system prompt (overrides persona)
            persona: Preset persona name (default, coder, teacher, analyst, creative)
        """
        self.client: LLMClient | None = None
        self.messages: list[dict[str, str]] = []
        self.current_message: str = ""
        self._is_initialized: bool = False
        
        # Set system prompt - custom takes priority over persona
        if system_prompt:
            self.system_prompt = system_prompt
        else:
            self.system_prompt = get_system_prompt(persona)

    async def __aenter__(self) -> Agent:
        """Async context manager entry - initialize resources."""
        self.client = LLMClient()
        self._is_initialized = True
        
        # Add system prompt as first message
        if self.system_prompt:
            self.messages = [{"role": "system", "content": self.system_prompt}]
        
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

    async def run(self, message: str) -> AsyncGenerator[AgentEvent, None]:
        """Run the agent with a user message.
        
        Args:
            message: The user's input message
            
        Yields:
            AgentEvent: Events for agent lifecycle and streaming
        """
        self._ensure_initialized()
        
        self.current_message = message
        # Add user message to conversation history
        self.messages.append({"role": "user", "content": message})
        
        yield AgentEvent.agent_start(message)
        
        final_response: str | None = None
        
        # Run the agentic loop
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
        """Core agentic loop - streams LLM responses as events."""
        response_text = ""

        async for event in self.client.chat_completion(self.messages, True):
            if event.type == StreamEventType.TEXT_DELTA:
                content = event.text_delta.content
                response_text += content
                yield AgentEvent.text_delta(content)
            elif event.type == StreamEventType.ERROR:
                yield AgentEvent.agent_error(event.error or "Unknown error")

        if response_text:
            yield AgentEvent.text_complete(response_text)

