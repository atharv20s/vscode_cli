"""
Memory Tools - Let the agent remember things across sessions.

These tools give the agent persistent memory!
"""

from __future__ import annotations
from typing import Any

from tools.base import Tool, ToolResult
from context.memory import get_memory


class RememberTool(Tool):
    """Store information in memory."""
    
    @property
    def name(self) -> str:
        return "remember"
    
    @property
    def description(self) -> str:
        return (
            "Store information in persistent memory for later recall. "
            "Use this to remember: project context, user preferences, "
            "coding patterns, important facts. Memory persists across sessions!"
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "key": {
                "type": "string",
                "description": "A short key to identify this memory (e.g., 'project_type', 'user_prefers_tabs')",
            },
            "value": {
                "type": "string",
                "description": "The information to remember",
            },
            "category": {
                "type": "string",
                "description": "Category: 'pattern', 'preference', 'context', or 'summary'",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["key", "value"]
    
    async def execute(
        self, 
        key: str, 
        value: str, 
        category: str = "context"
    ) -> ToolResult:
        try:
            memory = get_memory()
            memory.remember(key, value, category)
            return ToolResult.ok(
                f"✅ Remembered `{key}` ({category}): {value[:100]}..."
            )
        except Exception as e:
            return ToolResult.fail(f"Failed to remember: {e}")


class RecallTool(Tool):
    """Recall information from memory."""
    
    @property
    def name(self) -> str:
        return "recall"
    
    @property
    def description(self) -> str:
        return (
            "Recall information from persistent memory. "
            "Use to retrieve previously stored facts, preferences, or context."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "key": {
                "type": "string",
                "description": "The key to look up, or a search query",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["key"]
    
    async def execute(self, key: str) -> ToolResult:
        try:
            memory = get_memory()
            
            # Try exact match first
            value = memory.recall(key)
            if value:
                return ToolResult.ok(f"📝 `{key}`: {value}")
            
            # Try search
            results = memory.search(key)
            if results:
                output = f"🔍 Found {len(results)} memories matching '{key}':\n\n"
                for entry in results[:5]:
                    output += f"- **{entry.key}** ({entry.category}): {str(entry.value)[:100]}\n"
                return ToolResult.ok(output)
            
            return ToolResult.ok(f"No memory found for '{key}'")
        except Exception as e:
            return ToolResult.fail(f"Failed to recall: {e}")


class ListMemoriesTool(Tool):
    """List all stored memories."""
    
    @property
    def name(self) -> str:
        return "list_memories"
    
    @property
    def description(self) -> str:
        return "List all stored memories, optionally filtered by category."
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "category": {
                "type": "string",
                "description": "Filter by category: 'pattern', 'preference', 'context', 'summary'",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return []
    
    async def execute(self, category: str = "") -> ToolResult:
        try:
            memory = get_memory()
            stats = memory.stats()
            
            output = f"📊 **Memory Stats:**\n"
            output += f"- Total memories: {stats['total_memories']}\n"
            output += f"- Total summaries: {stats['total_summaries']}\n"
            output += f"- Categories: {stats['categories']}\n\n"
            
            if category:
                entries = memory.get_by_category(category)
                output += f"**{category.title()} Memories ({len(entries)}):**\n"
                for entry in entries[:10]:
                    output += f"- `{entry.key}`: {str(entry.value)[:80]}\n"
            else:
                # Show recent from each category
                for cat in ["preference", "pattern", "context"]:
                    entries = memory.get_by_category(cat)[:3]
                    if entries:
                        output += f"\n**{cat.title()}:**\n"
                        for entry in entries:
                            output += f"- `{entry.key}`: {str(entry.value)[:60]}\n"
            
            return ToolResult.ok(output)
        except Exception as e:
            return ToolResult.fail(f"Failed to list memories: {e}")


class ForgetTool(Tool):
    """Remove a memory."""
    
    @property
    def name(self) -> str:
        return "forget"
    
    @property
    def description(self) -> str:
        return "Remove a specific memory by its key."
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "key": {
                "type": "string",
                "description": "The key of the memory to forget",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["key"]
    
    async def execute(self, key: str) -> ToolResult:
        try:
            memory = get_memory()
            if memory.forget(key):
                return ToolResult.ok(f"🗑️ Forgot `{key}`")
            return ToolResult.ok(f"No memory found for `{key}`")
        except Exception as e:
            return ToolResult.fail(f"Failed to forget: {e}")


class SummarizeSessionTool(Tool):
    """Save a summary of the current session."""
    
    @property
    def name(self) -> str:
        return "summarize_session"
    
    @property
    def description(self) -> str:
        return (
            "Save a summary of what was accomplished in this session. "
            "Call this at the end of complex tasks to remember the context."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "task": {
                "type": "string",
                "description": "Brief description of the task",
            },
            "summary": {
                "type": "string",
                "description": "Summary of what was done",
            },
            "files_touched": {
                "type": "string",
                "description": "Comma-separated list of files modified",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["task", "summary"]
    
    async def execute(
        self, 
        task: str, 
        summary: str, 
        files_touched: str = ""
    ) -> ToolResult:
        try:
            memory = get_memory()
            files = [f.strip() for f in files_touched.split(",") if f.strip()]
            memory.add_summary(summary, task, files)
            return ToolResult.ok(f"📝 Session summary saved: {task}")
        except Exception as e:
            return ToolResult.fail(f"Failed to save summary: {e}")


# Export tools for discovery
TOOLS = [
    RememberTool(),
    RecallTool(),
    ListMemoriesTool(),
    ForgetTool(),
    SummarizeSessionTool(),
]
