import unittest
from unittest.mock import patch

from tools.base import ToolResult
from tools.orchestration import AgentOrchestrator, TaskStatus
from tools.subagents import SubagentResult


class FakeSubagent:
    calls = []

    def __init__(self, config):
        self.config = config

    async def run(self, task):
        self.__class__.calls.append((self.config.system_prompt, task))
        return SubagentResult(True, f"result for {task}", 1, [])


class OrchestratorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        FakeSubagent.calls.clear()

    async def test_dependency_order_and_shared_context(self):
        with patch("tools.orchestration.Subagent", FakeSubagent):
            report = await AgentOrchestrator(parallelism=2).run(
                "Ship a secure feature",
                [
                    {"id": "research", "role": "researcher", "task": "Find design options"},
                    {"id": "review", "role": "analyst", "task": "Review the design", "depends_on": ["research"]},
                    {"id": "draft", "role": "coder", "task": "Draft implementation", "depends_on": ["review"]},
                ],
            )
        self.assertTrue(report.success)
        self.assertTrue(all(task.status == TaskStatus.SUCCEEDED for task in report.tasks))
        self.assertEqual(len(FakeSubagent.calls), 3)
        self.assertIn("result for Find design options", FakeSubagent.calls[1][0])
        self.assertIn("result for Review the design", FakeSubagent.calls[2][0])

    async def test_cycle_rejected_before_agents_start(self):
        with patch("tools.orchestration.Subagent", FakeSubagent):
            with self.assertRaisesRegex(ValueError, "cycle"):
                await AgentOrchestrator().run("Goal", [
                    {"id": "a", "role": "analyst", "task": "A", "depends_on": ["b"]},
                    {"id": "b", "role": "analyst", "task": "B", "depends_on": ["a"]},
                ])
        self.assertEqual(FakeSubagent.calls, [])

    async def test_failed_dependency_blocks_downstream_only(self):
        class PartlyFailingSubagent(FakeSubagent):
            async def run(self, task):
                if task == "fail":
                    return SubagentResult(False, "", 1, [], "simulated failure")
                return SubagentResult(True, f"ok: {task}", 1, [])

        with patch("tools.orchestration.Subagent", PartlyFailingSubagent):
            report = await AgentOrchestrator(retries=0).run("Goal", [
                {"id": "bad", "role": "analyst", "task": "fail"},
                {"id": "blocked", "role": "coder", "task": "dependent", "depends_on": ["bad"]},
                {"id": "independent", "role": "planner", "task": "continue"},
            ])
        statuses = {task.id: task.status for task in report.tasks}
        self.assertEqual(statuses["bad"], TaskStatus.FAILED)
        self.assertEqual(statuses["blocked"], TaskStatus.BLOCKED)
        self.assertEqual(statuses["independent"], TaskStatus.SUCCEEDED)
        self.assertFalse(report.success)

    async def test_duplicate_ids_and_unknown_dependencies_are_rejected(self):
        orchestrator = AgentOrchestrator()
        with self.assertRaisesRegex(ValueError, "unique"):
            await orchestrator.run("Goal", [
                {"id": "x", "role": "analyst", "task": "one"},
                {"id": "x", "role": "analyst", "task": "two"},
            ])
        with self.assertRaisesRegex(ValueError, "unknown"):
            await orchestrator.run("Goal", [
                {"id": "x", "role": "analyst", "task": "one", "depends_on": ["missing"]},
            ])


if __name__ == "__main__":
    unittest.main()
