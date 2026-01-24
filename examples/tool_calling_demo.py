"""
Tool Calling Demo - Shows how the Tool Registry integrates with LLM.

This demonstrates:
1. Setting up tools
2. Getting OpenAI-compatible schemas
3. Passing tools to LLM
4. Executing tool calls from LLM response
"""

import asyncio
import json
from tools import setup_tools, get_registry, Tool, ToolResult, FunctionTool, tool


async def demo_tool_registration():
    """Demo 1: Basic tool registration and schema generation."""
    
    print("=" * 60)
    print("DEMO 1: Tool Registration & Schema Generation")
    print("=" * 60)
    
    # Setup discovers and registers all builtin tools
    registry = setup_tools()
    
    print("\n📦 Registered Tools:")
    for name in registry.list_tools():
        t = registry.get(name)
        print(f"  • {name}: {t.description[:50]}...")
    
    print("\n📋 OpenAI Function Schema (for read_file):")
    schema = registry.get_definition("read_file").to_openai_format()
    print(json.dumps(schema, indent=2))
    
    return registry


async def demo_custom_tool():
    """Demo 2: Creating and registering a custom tool."""
    
    print("\n" + "=" * 60)
    print("DEMO 2: Custom Tool Creation")
    print("=" * 60)
    
    registry = get_registry()
    
    # Method 1: Using the @tool decorator
    @tool(
        name="calculator",
        description="Evaluate a mathematical expression",
        parameters={
            "expression": {
                "type": "string",
                "description": "Math expression like '2 + 2' or '10 * 5'"
            }
        },
        required=["expression"]
    )
    async def calculator(expression: str) -> str:
        try:
            # Safe eval for math only
            allowed = set("0123456789+-*/(). ")
            if all(c in allowed for c in expression):
                result = eval(expression)
                return f"Result: {expression} = {result}"
            return "Error: Only basic math operations allowed"
        except Exception as e:
            return f"Error: {str(e)}"
    
    # Register the decorated function (it's now a FunctionTool)
    registry.register(calculator)
    
    print("\n✅ Registered custom 'calculator' tool")
    print(f"   Tools now: {registry.list_tools()}")
    
    # Test it
    result = await registry.execute("calculator", expression="25 * 4 + 10")
    print(f"\n🧮 Calculator test: {result.output}")
    
    # Method 2: Using FunctionTool.create()
    async def get_time() -> str:
        from datetime import datetime
        return f"Current time: {datetime.now().strftime('%H:%M:%S')}"
    
    time_tool = FunctionTool.create(
        name="get_time",
        description="Get the current time",
        func=get_time,
        parameters={},
    )
    registry.register(time_tool)
    
    result = await registry.execute("get_time")
    print(f"⏰ Time tool test: {result.output}")


async def demo_read_file():
    """Demo 3: Using the read_file tool."""
    
    print("\n" + "=" * 60)
    print("DEMO 3: Read File Tool")
    print("=" * 60)
    
    registry = get_registry()
    
    # Read full file
    result = await registry.execute("read_file", path="main.py")
    if result.success:
        lines = result.output.split('\n')
        print(f"\n📄 Read main.py ({len(lines)} lines)")
        print("   First 5 lines:")
        for line in lines[:5]:
            print(f"   | {line}")
    else:
        print(f"❌ Error: {result.error}")
    
    # Read specific line range
    result = await registry.execute(
        "read_file", 
        path="main.py",
        start_line=1,
        end_line=10
    )
    if result.success:
        print(f"\n📄 Read lines 1-10:")
        print(result.output)


async def demo_llm_integration():
    """Demo 4: Full LLM integration flow."""
    
    print("\n" + "=" * 60)
    print("DEMO 4: LLM Integration Flow")
    print("=" * 60)
    
    registry = get_registry()
    
    # Step 1: Get all tool schemas for LLM
    tool_schemas = registry.get_definitions()
    
    print("\n📤 SENDING TO LLM:")
    print(f"   Model: mistralai/devstral-2512:free")
    print(f"   Tools: {len(tool_schemas)} available")
    
    # This is what you'd send to the LLM API
    llm_request = {
        "model": "mistralai/devstral-2512:free",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant with tools."},
            {"role": "user", "content": "What's in main.py?"}
        ],
        "tools": tool_schemas,  # <-- Tool schemas go here!
        "tool_choice": "auto"
    }
    
    print("\n   Request structure:")
    print(f"   - messages: {len(llm_request['messages'])} messages")
    print(f"   - tools: {len(llm_request['tools'])} tool definitions")
    
    # Step 2: Simulate LLM response with tool call
    print("\n📥 LLM RESPONSE (simulated):")
    simulated_tool_call = {
        "id": "call_abc123",
        "type": "function",
        "function": {
            "name": "read_file",
            "arguments": '{"path": "main.py", "start_line": 1, "end_line": 5}'
        }
    }
    print(f"   Tool call: {simulated_tool_call['function']['name']}")
    print(f"   Arguments: {simulated_tool_call['function']['arguments']}")
    
    # Step 3: Execute the tool
    print("\n⚙️ EXECUTING TOOL:")
    args = json.loads(simulated_tool_call['function']['arguments'])
    result = await registry.execute(
        simulated_tool_call['function']['name'],
        **args
    )
    
    print(f"   Success: {result.success}")
    print(f"   Output preview: {result.output[:100]}...")
    
    # Step 4: Return result to LLM
    tool_response = {
        "role": "tool",
        "tool_call_id": simulated_tool_call['id'],
        "content": result.output if result.success else f"Error: {result.error}"
    }
    
    print("\n📤 RETURNING TO LLM:")
    print(f"   Tool response added to messages")
    print(f"   LLM will now generate final response based on tool output")


async def main():
    """Run all demos."""
    print("\n🛠️  TOOL CALLING SYSTEM DEMO")
    print("=" * 60)
    
    await demo_tool_registration()
    await demo_custom_tool()
    await demo_read_file()
    await demo_llm_integration()
    
    print("\n" + "=" * 60)
    print("✅ All demos complete!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
