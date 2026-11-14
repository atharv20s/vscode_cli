import unittest

from Agent.core import Agent
from tools.base import Tool, ToolResult


class FakeTool(Tool):
    def __init__(self, name, dangerous=False):
        self._name = name
        self._dangerous = dangerous
        self.executed = False

    @property
    def name(self):
        return self._name

    @property
    def description(self):
        return "Test tool"

    @property
    def parameters(self):
        return {}

    @property
    def is_dangerous(self):
        return self._dangerous

    async def execute(self, **kwargs):
        self.executed = True
        return ToolResult.ok("executed")


class FakeRegistry:
    def __init__(self, tool):
        self.tool = tool

    def get(self, name):
        return self.tool if name == self.tool.name else None

    async def execute(self, name, **kwargs):
        return await self.tool.execute(**kwargs)


class AgentApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def test_dangerous_tool_denied_without_approval_handler(self):
        tool = FakeTool("shell", dangerous=True)
        agent = Agent(tools_enabled=False)
        agent.registry = FakeRegistry(tool)
        result = await agent._execute_tool("shell", {"command": "id"})
        self.assertFalse(result.success)
        self.assertIn("requires explicit user approval", result.error)
        self.assertFalse(tool.executed)

    async def test_dangerous_tool_denied_when_user_rejects(self):
        tool = FakeTool("write_file", dangerous=True)
        agent = Agent(tools_enabled=False, approval_callback=lambda *_: False)
        agent.registry = FakeRegistry(tool)
        result = await agent._execute_tool("write_file", {"path": "x", "content": "y"})
        self.assertFalse(result.success)
        self.assertIn("denied by the user", result.error)
        self.assertFalse(tool.executed)

    async def test_dangerous_tool_runs_only_after_explicit_approval(self):
        tool = FakeTool("shell", dangerous=True)
        approvals = []
        agent = Agent(tools_enabled=False, approval_callback=lambda selected, args: approvals.append((selected.name, args)) or True)
        agent.registry = FakeRegistry(tool)
        result = await agent._execute_tool("shell", {"command": "pytest"})
        self.assertTrue(result.success)
        self.assertTrue(tool.executed)
        self.assertEqual(approvals, [("shell", {"command": "pytest"})])

    async def test_read_only_tool_does_not_prompt(self):
        tool = FakeTool("read_file", dangerous=False)
        agent = Agent(tools_enabled=False)
        agent.registry = FakeRegistry(tool)
        result = await agent._execute_tool("read_file", {"path": "README.md"})
        self.assertTrue(result.success)
        self.assertTrue(tool.executed)


if __name__ == "__main__":
    unittest.main()