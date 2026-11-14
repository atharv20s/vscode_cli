"""
Memory System - Persistent memory across sessions.

This gives your agent MEMORY - something Claude/GPT lack!
- Remembers project context
- Learns your coding patterns
- Stores conversation summaries
- Tracks file changes
"""

from __future__ import annotations
import json
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Any
from dataclasses import dataclass, field, asdict


@dataclass
class MemoryEntry:
    """A single memory entry."""
    key: str
    value: Any
    category: str  # "pattern", "preference", "context", "summary"
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    importance: int = 1  # 1-5, higher = more important
    
    def to_dict(self) -> dict:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: dict) -> MemoryEntry:
        return cls(**data)


class ProjectMemory:
    """
    Persistent memory for project context.
    
    Stores:
    - Project type and structure
    - Coding patterns you use
    - User preferences
    - Conversation summaries
    - Key files and their purposes
    """
    
    def __init__(self, project_path: str = "."):
        self.project_path = Path(project_path).resolve()
        self.memory_dir = self.project_path / ".agent_memory"
        self.memory_file = self.memory_dir / "memory.json"
        self.summaries_file = self.memory_dir / "summaries.json"
        
        # Create memory directory
        self.memory_dir.mkdir(exist_ok=True)
        
        # Load existing memory
        self._memory = self._load_memory()
        self._summaries = self._load_summaries()
    
    def _load_memory(self) -> dict[str, MemoryEntry]:
        """Load memory from disk."""
        if self.memory_file.exists():
            try:
                data = json.loads(self.memory_file.read_text())
                return {k: MemoryEntry.from_dict(v) for k, v in data.items()}
            except:
                return {}
        return {}
    
    def _load_summaries(self) -> list[dict]:
        """Load conversation summaries."""
        if self.summaries_file.exists():
            try:
                return json.loads(self.summaries_file.read_text())
            except:
                return []
        return []
    
    def save(self):
        """Save memory to disk."""
        # Save memory entries
        data = {k: v.to_dict() for k, v in self._memory.items()}
        self.memory_file.write_text(json.dumps(data, indent=2))
        
        # Save summaries
        self.summaries_file.write_text(json.dumps(self._summaries, indent=2))
    
    def remember(
        self, 
        key: str, 
        value: Any, 
        category: str = "context",
        importance: int = 1
    ):
        """Store a memory."""
        self._memory[key] = MemoryEntry(
            key=key,
            value=value,
            category=category,
            importance=importance,
        )
        self.save()
    
    def recall(self, key: str) -> Any | None:
        """Recall a specific memory."""
        entry = self._memory.get(key)
        return entry.value if entry else None
    
    def search(self, query: str, category: str | None = None) -> list[MemoryEntry]:
        """Search memories by query string."""
        results = []
        query_lower = query.lower()
        
        for entry in self._memory.values():
            if category and entry.category != category:
                continue
            
            # Search in key and value
            if query_lower in entry.key.lower():
                results.append(entry)
            elif isinstance(entry.value, str) and query_lower in entry.value.lower():
                results.append(entry)
        
        # Sort by importance
        results.sort(key=lambda x: x.importance, reverse=True)
        return results
    
    def get_by_category(self, category: str) -> list[MemoryEntry]:
        """Get all memories in a category."""
        return [e for e in self._memory.values() if e.category == category]
    
    def add_pattern(self, pattern: str, description: str):
        """Remember a coding pattern."""
        key = f"pattern_{hashlib.md5(pattern.encode()).hexdigest()[:8]}"
        self.remember(key, {"pattern": pattern, "description": description}, "pattern", 3)
    
    def add_preference(self, name: str, value: Any):
        """Remember a user preference."""
        self.remember(f"pref_{name}", value, "preference", 4)
    
    def get_preferences(self) -> dict[str, Any]:
        """Get all user preferences."""
        prefs = {}
        for entry in self.get_by_category("preference"):
            name = entry.key.replace("pref_", "")
            prefs[name] = entry.value
        return prefs
    
    def add_summary(self, summary: str, task: str, files_touched: list[str]):
        """Add a conversation summary."""
        self._summaries.append({
            "timestamp": datetime.now().isoformat(),
            "task": task,
            "summary": summary,
            "files": files_touched,
        })
        # Keep last 50 summaries
        self._summaries = self._summaries[-50:]
        self.save()
    
    def get_recent_summaries(self, count: int = 5) -> list[dict]:
        """Get recent conversation summaries."""
        return self._summaries[-count:]
    
    def set_project_info(self, info: dict):
        """Set project metadata."""
        self.remember("project_info", info, "context", 5)
    
    def get_project_info(self) -> dict | None:
        """Get project metadata."""
        return self.recall("project_info")
    
    def generate_context_prompt(self) -> str:
        """Generate a context string for the system prompt."""
        lines = []
        
        # Project info
        project = self.get_project_info()
        if project:
            lines.append("## Project Context")
            if project.get("name"):
                lines.append(f"- Project: {project['name']}")
            if project.get("type"):
                lines.append(f"- Type: {project['type']}")
            if project.get("language"):
                lines.append(f"- Language: {project['language']}")
            if project.get("framework"):
                lines.append(f"- Framework: {project['framework']}")
        
        # Recent work
        summaries = self.get_recent_summaries(3)
        if summaries:
            lines.append("\n## Recent Work")
            for s in summaries:
                lines.append(f"- {s['task']}: {s['summary'][:100]}...")
        
        # Patterns
        patterns = self.get_by_category("pattern")
        if patterns:
            lines.append("\n## Known Patterns")
            for p in patterns[:5]:
                lines.append(f"- {p.value.get('description', '')}")
        
        # Preferences
        prefs = self.get_preferences()
        if prefs:
            lines.append("\n## User Preferences")
            for name, value in list(prefs.items())[:5]:
                lines.append(f"- {name}: {value}")
        
        return "\n".join(lines) if lines else ""
    
    def forget(self, key: str) -> bool:
        """Remove a memory."""
        if key in self._memory:
            del self._memory[key]
            self.save()
            return True
        return False
    
    def clear_all(self):
        """Clear all memories."""
        self._memory = {}
        self._summaries = []
        self.save()
    
    def stats(self) -> dict:
        """Get memory statistics."""
        categories = {}
        for entry in self._memory.values():
            categories[entry.category] = categories.get(entry.category, 0) + 1
        
        return {
            "total_memories": len(self._memory),
            "total_summaries": len(self._summaries),
            "categories": categories,
        }


# Global memory instance
_memory: ProjectMemory | None = None


def get_memory(project_path: str = ".") -> ProjectMemory:
    """Get or create the global memory instance."""
    global _memory
    if _memory is None:
        _memory = ProjectMemory(project_path)
    return _memory


def reset_memory():
    """Reset the global memory instance."""
    global _memory
    _memory = None
