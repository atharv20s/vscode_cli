"""
Agent Modes - Different interaction styles like GitHub Copilot.

Modes:
- ASK: Just answer questions, no file changes
- EDIT: Make targeted file changes
- AGENT: Full autonomous agent with planning
- PLAN: Think and plan before acting
- THINK: Deep reasoning mode
"""

from __future__ import annotations
from enum import Enum
from dataclasses import dataclass


class AgentMode(Enum):
    """Available agent modes."""
    ASK = "ask"          # Answer questions only
    EDIT = "edit"        # Make file edits
    AGENT = "agent"      # Full autonomous mode
    PLAN = "plan"        # Plan before acting
    THINK = "think"      # Deep reasoning mode
    DEBUG = "debug"      # Debugging specialist
    REVIEW = "review"    # Code review mode


@dataclass
class ModeConfig:
    """Configuration for each mode."""
    mode: AgentMode  # The mode this config belongs to
    name: str
    description: str
    system_prompt_addon: str
    tools_enabled: bool
    auto_verify: bool  # Automatically verify code after writing
    require_plan: bool  # Force planning step before execution
    max_iterations: int


# Mode configurations
MODE_CONFIGS: dict[AgentMode, ModeConfig] = {
    AgentMode.ASK: ModeConfig(
        mode=AgentMode.ASK,
        name="Ask",
        description="Answer questions without making changes",
        system_prompt_addon="""
## ASK MODE
You are in ASK mode. Answer questions helpfully but DO NOT:
- Create or modify files
- Execute code that changes state
- Run dangerous commands

You CAN:
- Read files to answer questions
- Analyze code structure
- Search the codebase
- Explain concepts
""",
        tools_enabled=True,
        auto_verify=False,
        require_plan=False,
        max_iterations=5,
    ),
    
    AgentMode.EDIT: ModeConfig(
        mode=AgentMode.EDIT,
        name="Edit",
        description="Make targeted file changes",
        system_prompt_addon="""
## EDIT MODE
You are in EDIT mode. Make focused, targeted edits:
- Edit only the files necessary for the task
- Make minimal changes
- Preserve existing code style
- Don't refactor unrelated code

After each edit:
1. Verify the syntax is correct
2. Check for obvious errors
3. Confirm the change matches the request
""",
        tools_enabled=True,
        auto_verify=True,
        require_plan=False,
        max_iterations=8,
    ),
    
    AgentMode.AGENT: ModeConfig(
        mode=AgentMode.AGENT,
        name="Agent",
        description="Full autonomous agent with all capabilities",
        system_prompt_addon="""
## AGENT MODE
You are in full AGENT mode with complete autonomy:
- Plan complex tasks step by step
- Execute multi-file changes
- Run tests to verify changes
- Iterate until the task is complete
- Use all available tools

Workflow:
1. Understand the task fully
2. Plan your approach
3. Execute step by step
4. Verify each step
5. Report completion
""",
        tools_enabled=True,
        auto_verify=True,
        require_plan=True,
        max_iterations=15,
    ),
    
    AgentMode.PLAN: ModeConfig(
        mode=AgentMode.PLAN,
        name="Plan",
        description="Think and plan before acting",
        system_prompt_addon="""
## PLAN MODE
You are in PLAN mode. Before doing ANYTHING:

1. **ANALYZE**: Read all relevant files
2. **UNDERSTAND**: What exactly needs to be done?
3. **PLAN**: Create a detailed step-by-step plan
4. **VERIFY PLAN**: Check for issues in your plan
5. **THEN EXECUTE**: Only after planning is complete

Your plan should include:
- Files to modify
- Specific changes to make
- Order of operations
- Potential risks
- Verification steps

SHOW YOUR PLAN BEFORE EXECUTING.
""",
        tools_enabled=True,
        auto_verify=True,
        require_plan=True,
        max_iterations=12,
    ),
    
    AgentMode.THINK: ModeConfig(
        mode=AgentMode.THINK,
        name="Think",
        description="Deep reasoning and analysis",
        system_prompt_addon="""
## THINK MODE
You are in THINK mode. Use deep reasoning:

**For every task:**
1. State your understanding of the problem
2. List all relevant considerations
3. Explore multiple approaches
4. Analyze trade-offs of each approach
5. Choose the best approach with justification
6. Think about edge cases
7. Consider what could go wrong
8. Then proceed with implementation

Format your thinking:
```thinking
<your detailed reasoning here>
```

Then provide your solution.
""",
        tools_enabled=True,
        auto_verify=True,
        require_plan=True,
        max_iterations=10,
    ),
    
    AgentMode.DEBUG: ModeConfig(
        mode=AgentMode.DEBUG,
        name="Debug",
        description="Debugging specialist",
        system_prompt_addon="""
## DEBUG MODE
You are in DEBUG mode. Systematic debugging:

1. **REPRODUCE**: Understand the exact error/behavior
2. **GATHER INFO**: Use analyze_code, read_file to understand
3. **HYPOTHESIZE**: Form theories about the cause
4. **TEST**: Use run_python to test theories
5. **FIX**: Make minimal, targeted fix
6. **VERIFY**: Run tests to confirm fix

Rules:
- Never guess - always verify
- One change at a time
- Test after each change
- Find root cause, not symptoms
""",
        tools_enabled=True,
        auto_verify=True,
        require_plan=False,
        max_iterations=15,
    ),
    
    AgentMode.REVIEW: ModeConfig(
        mode=AgentMode.REVIEW,
        name="Review",
        description="Code review mode",
        system_prompt_addon="""
## REVIEW MODE
You are in CODE REVIEW mode. Review code for:

1. **Correctness**: Does it work correctly?
2. **Bugs**: Are there potential bugs?
3. **Security**: Any security issues?
4. **Performance**: Performance problems?
5. **Style**: Code style and readability?
6. **Best Practices**: Following conventions?
7. **Tests**: Are there adequate tests?

For each issue found:
- Severity: Critical/Major/Minor/Suggestion
- Location: File and line
- Description: What's wrong
- Suggestion: How to fix

Do NOT make changes - only review and report.
""",
        tools_enabled=True,
        auto_verify=False,
        require_plan=False,
        max_iterations=5,
    ),
}


def get_mode_config(mode: AgentMode) -> ModeConfig:
    """Get configuration for a mode."""
    return MODE_CONFIGS.get(mode, MODE_CONFIGS[AgentMode.AGENT])


def get_mode_prompt(mode: AgentMode) -> str:
    """Get the system prompt addon for a mode."""
    config = get_mode_config(mode)
    return config.system_prompt_addon


def get_all_modes() -> list[ModeConfig]:
    """Get all mode configurations."""
    return list(MODE_CONFIGS.values())


def list_modes() -> list[dict]:
    """List all available modes with descriptions."""
    return [
        {
            "mode": mode.value,
            "name": config.name,
            "description": config.description,
        }
        for mode, config in MODE_CONFIGS.items()
    ]
