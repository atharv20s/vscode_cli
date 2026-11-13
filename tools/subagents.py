"""
Subagent Tools - Tools that spawn child agents for complex tasks.

Subagents are autonomous agents that can:
- Research topics deeply
- Execute multi-step tasks
- Return structured results
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any
import asyncio
from enum import Enum

from tools.base import Tool, ToolResult


class SubagentType(Enum):
    """Types of subagents available."""
    RESEARCHER = "researcher"      # Deep research on a topic
    CODER = "coder"               # Code generation and review
    ANALYST = "analyst"           # Data analysis
    EXECUTOR = "executor"         # Multi-step task execution


@dataclass
class SubagentConfig:
    """Configuration for a subagent."""
    type: SubagentType
    system_prompt: str
    max_iterations: int = 10
    timeout_seconds: float = 120.0
    tools_enabled: list[str] | None = None
    mode: str = "agent"


@dataclass
class SubagentResult:
    """Result from a subagent execution."""
    success: bool
    output: str
    iterations: int
    tool_calls: list[dict[str, Any]]
    error: str | None = None
    
    def to_tool_result(self) -> ToolResult:
        """Convert to a standard ToolResult."""
        if self.success:
            return ToolResult.ok(
                self.output,
                iterations=self.iterations,
                tool_calls=self.tool_calls,
            )
        return ToolResult.fail(
            self.error or "Subagent failed",
            iterations=self.iterations,
        )


class Subagent:
    """
    A child agent that executes autonomously.
    
    Subagents have their own:
    - System prompt
    - Tool access
    - Iteration limit
    - Conversation history
    """
    
    def __init__(self, config: SubagentConfig):
        self.config = config
        self.iterations = 0
        self.tool_calls: list[dict[str, Any]] = []
        self.messages: list[dict[str, str]] = []
    
    async def run(self, task: str) -> SubagentResult:
        """Run a real child agent; never report placeholder success."""
        self.messages = [
            {"role": "system", "content": self.config.system_prompt},
            {"role": "user", "content": task},
        ]
        tool_events: list[dict[str, Any]] = []
        final_text = ""
        failure: str | None = None
        iterations = 0

        async def execute() -> None:
            nonlocal final_text, failure, iterations
            from Agent.core import Agent
            from Agent.modes import AgentMode

            try:
                selected_mode = AgentMode(self.config.mode)
            except ValueError:
                selected_mode = AgentMode.AGENT

            async with Agent(
                system_prompt=self.config.system_prompt,
                tools_enabled=True,
                max_iterations=self.config.max_iterations,
                mode=selected_mode,
                allowed_tools=self.config.tools_enabled,
            ) as agent:
                async for event in agent.run(task):
                    if event.type == AgentEventType.TEXT_COMPLETE:
                        final_text = str(event.data.get("content") or "")
                    elif event.type == AgentEventType.TOOL_EXECUTING:
                        tool_events.append({
                            "name": event.data.get("name"),
                            "arguments": event.data.get("arguments", {}),
                        })
                    elif event.type == AgentEventType.AGENT_ERROR:
                        failure = str(event.data.get("error") or "Child agent reported an error.")
                iterations = agent.current_turn
                self.messages = list(agent.messages)

        try:
            await asyncio.wait_for(execute(), timeout=max(1.0, self.config.timeout_seconds))
        except asyncio.TimeoutError:
            failure = f"Subagent timed out after {self.config.timeout_seconds:g} seconds."
        except Exception as error:
            failure = f"Subagent execution failed: {error}"

        output = final_text.strip()
        success = bool(output) and failure is None
        if not success and not failure:
            failure = "Subagent completed without a final response."
        self.iterations = iterations
        self.tool_calls = tool_events
        return SubagentResult(
            success=success,
            output=output,
            iterations=iterations,
            tool_calls=tool_events,
            error=failure,
        )

class ResearcherTool(Tool):
    """
    Spawns a researcher subagent to investigate a topic.
    
    The researcher will:
    - Search for information
    - Synthesize findings
    - Return a summary
    """
    
    @property
    def name(self) -> str:
        return "researcher"
    
    @property
    def description(self) -> str:
        return (
            "Spawn a research agent to investigate a topic deeply. "
            "Use for complex questions requiring multiple sources."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "topic": {
                "type": "string",
                "description": "The topic or question to research",
            },
            "depth": {
                "type": "string",
                "enum": ["quick", "standard", "deep"],
                "description": "How thorough the research should be",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["topic"]
    
    async def execute(self, topic: str, depth: str = "standard") -> ToolResult:
        """Execute research on the topic."""
        config = SubagentConfig(
            type=SubagentType.RESEARCHER,
            system_prompt=(
                "You are a careful researcher. Use available search and read-only tools, "
                "compare evidence, cite source URLs when present, distinguish facts from "
                "uncertainty, and do not modify the workspace."
            ),
            max_iterations={"quick": 3, "standard": 5, "deep": 10}.get(depth, 5),
            timeout_seconds=180.0 if depth == "deep" else 90.0,
            tools_enabled=["read_file", "list_dir", "grep", "glob", "web_search", "fetch_url", "analyze_code"],
            mode="ask",
        )
        
        subagent = Subagent(config)
        result = await subagent.run(f"Research: {topic}")
        return result.to_tool_result()


class CoderTool(Tool):
    """
    Spawns a coder subagent to generate or review code.
    """
    
    @property
    def name(self) -> str:
        return "coder_agent"
    
    @property
    def description(self) -> str:
        return (
            "Spawn a coding agent to write, review, or refactor code. "
            "Use for complex coding tasks."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "task": {
                "type": "string",
                "description": "The coding task to perform",
            },
            "language": {
                "type": "string",
                "description": "Programming language (e.g., python, javascript)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["task"]
    
    async def execute(self, task: str, language: str = "python") -> ToolResult:
        """Execute the coding task."""
        config = SubagentConfig(
            type=SubagentType.CODER,
            system_prompt=(
                f"You are an expert {language} engineer. Inspect existing code, make focused "
                "changes, use explicit permissions for commands, and report actual verification."
            ),
            max_iterations=8,
            timeout_seconds=180.0,
            tools_enabled=[
                "read_file", "list_dir", "grep", "glob", "analyze_code",
                "find_definition", "find_usages", "write_file", "edit_file",
                "shell", "git_status", "git_diff",
            ],
            mode="agent",
        )
        
        subagent = Subagent(config)
        result = await subagent.run(task)
        return result.to_tool_result()


class TaskExecutorTool(Tool):
    """
    Spawns an executor subagent to complete multi-step tasks.
    """
    
    @property
    def name(self) -> str:
        return "task_executor"
    
    @property
    def description(self) -> str:
        return (
            "Spawn an executor agent to complete a multi-step task. "
            "Use for tasks requiring planning and multiple actions."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "task": {
                "type": "string",
                "description": "The task to complete",
            },
            "steps": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional predefined steps to follow",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["task"]
    
    async def execute(
        self,
        task: str,
        steps: list[str] | None = None,
    ) -> ToolResult:
        """Execute the multi-step task."""
        config = SubagentConfig(
            type=SubagentType.EXECUTOR,
            system_prompt=(
                "You are an execution specialist. Work through the supplied steps, inspect "
                "before editing, request approval for gated execution, and report exact results."
            ),
            max_iterations=10,
            timeout_seconds=240.0,
            tools_enabled=[
                "read_file", "list_dir", "grep", "glob", "analyze_code",
                "create_plan", "update_plan", "write_file", "edit_file",
                "shell", "git_status", "git_diff",
            ],
            mode="agent",
        )
        
        subagent = Subagent(config)
        full_task = task
        if steps:
            full_task += f"\n\nSteps:\n" + "\n".join(f"- {s}" for s in steps)
        
        result = await subagent.run(full_task)
        return result.to_tool_result()


# Tools to be registered
TOOLS = [
    ResearcherTool(),
    CoderTool(),
    TaskExecutorTool(),
]


def get_tools() -> list[Tool]:
    """Get all subagent tools."""
    return TOOLS
