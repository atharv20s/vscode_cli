import asyncio
import unittest
from unittest.mock import patch

from CLIENT.response import StreamEvent, StreamEventType, TextDelta, ToolCallDelta
from tools.base import ToolResult
from tools.subagents import Subagent, SubagentConfig, SubagentType


class FakeTool:
    name = "web_search"


class FakeRegistry:
    def __init__(self):
        self.calls = []

    def get_all(self):
        return [FakeTool()]

    def get_definitions(self):
        return [{
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search",
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}}},
            },
        }]

    async def execute(self, name, **kwargs):
        self.calls.append((name, kwargs))
        return ToolResult.ok("Search evidence", query=kwargs.get("query"))


class FakeLLMClient:
    instances = []

    def __init__(self, model=None):
        self.calls = 0
        self.closed = False
        self.__class__.instances.append(self)

    async def chat_completion(self, messages, stream=True, tools=None):
        self.calls += 1
        if self.calls == 1:
            yield StreamEvent(
                type=StreamEventType.TOOL_CALL,
                tool_calls=[ToolCallDelta("call_1", "web_search", '{"query":"Linux namespaces"}')],
                finish_reason="tool_calls",
            )
        else:
            yield StreamEvent(
                type=StreamEventType.TEXT_DELTA,
                text_delta=TextDelta("Namespaces isolate process views."),
            )

    async def close(self):
        self.closed = True


class SubagentRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        FakeLLMClient.instances.clear()
        self.registry = FakeRegistry()
        self.registry_patch = patch("tools.subagents.Subagent._tool_registry", return_value=self.registry)
        self.registry_patch.start()
        self.client_patch = patch("tools.subagents.LLMClient", FakeLLMClient)
        self.client_patch.start()

    async def asyncTearDown(self):
        self.registry_patch.stop()
        self.client_patch.stop()

    async def test_subagent_runs_model_and_uses_only_web_search(self):
        agent = Subagent(SubagentConfig(
            type=SubagentType.RESEARCHER,
            system_prompt="Research carefully.",
            max_iterations=3,
        ))
        result = await agent.run("Explain Linux namespaces.")
        self.assertTrue(result.success, result.error)
        self.assertIn("Namespaces isolate", result.output)
        self.assertEqual(result.iterations, 2)
        self.assertEqual(self.registry.calls, [("web_search", {"query": "Linux namespaces"})])
        self.assertTrue(FakeLLMClient.instances[0].closed)

    async def test_subagent_rejects_unapproved_tool_calls(self):
        class UnsafeClient(FakeLLMClient):
            async def chat_completion(self, messages, stream=True, tools=None):
                yield StreamEvent(
                    type=StreamEventType.TOOL_CALL,
                    tool_calls=[ToolCallDelta("call_unsafe", "shell", '{"command":"id"}')],
                    finish_reason="tool_calls",
                )

        with patch("tools.subagents.LLMClient", UnsafeClient):
            agent = Subagent(SubagentConfig(
                type=SubagentType.RESEARCHER,
                system_prompt="Research.",
            ))
            result = await agent.run("Try an unsafe tool.")
        self.assertFalse(result.success)
        self.assertIn("not permitted", result.error)
        self.assertEqual(self.registry.calls, [])

    async def test_rejects_empty_and_oversized_tasks(self):
        agent = Subagent(SubagentConfig(type=SubagentType.ANALYST, system_prompt="Analyze."))
        empty = await agent.run("  ")
        oversized = await agent.run("x" * (agent.MAX_TASK_CHARS + 1))
        self.assertFalse(empty.success)
        self.assertFalse(oversized.success)
        self.assertEqual(FakeLLMClient.instances, [])

    async def test_iteration_budget_is_enforced(self):
        class EndlessToolClient(FakeLLMClient):
            async def chat_completion(self, messages, stream=True, tools=None):
                yield StreamEvent(
                    type=StreamEventType.TOOL_CALL,
                    tool_calls=[ToolCallDelta("call_1", "web_search", '{"query":"repeat"}')],
                    finish_reason="tool_calls",
                )

        with patch("tools.subagents.LLMClient", EndlessToolClient):
            agent = Subagent(SubagentConfig(
                type=SubagentType.RESEARCHER,
                system_prompt="Research.",
                max_iterations=1,
            ))
            result = await agent.run("Keep searching.")
        self.assertFalse(result.success)
        self.assertIn("iteration limit", result.error)


if __name__ == "__main__":
    unittest.main()
