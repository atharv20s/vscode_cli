"""
Web tools - Search and fetch web content.
"""

from __future__ import annotations
import asyncio
from typing import Any

from tools.base import Tool, ToolResult


class WebSearchTool(Tool):
    """
    Search the web using DuckDuckGo.
    Free, no API key required!
    """
    
    @property
    def name(self) -> str:
        return "web_search"
    
    @property
    def description(self) -> str:
        return (
            "Search the web for information using DuckDuckGo. "
            "Returns relevant search results with titles, URLs, and snippets."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "query": {
                "type": "string",
                "description": "The search query",
            },
            "num_results": {
                "type": "integer",
                "description": "Number of results to return (default: 5, max: 10)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["query"]
    
    async def execute(
        self,
        query: str,
        num_results: int = 5,
    ) -> ToolResult:
        """Execute web search using DuckDuckGo."""
        try:
            from ddgs import DDGS
            
            # Cap results
            num_results = min(num_results, 10)
            
            # Run sync search in thread pool
            def do_search():
                ddgs = DDGS()
                return list(ddgs.text(query, max_results=num_results))
            
            loop = asyncio.get_event_loop()
            results = await loop.run_in_executor(None, do_search)
            
            if not results:
                return ToolResult.ok(
                    f"No results found for: '{query}'",
                    query=query,
                    count=0,
                )
            
            # Format results
            output_lines = [f"🔍 Search results for: '{query}'\n"]
            for i, r in enumerate(results, 1):
                title = r.get("title", "No title")
                url = r.get("href", r.get("link", ""))
                snippet = r.get("body", r.get("snippet", ""))
                output_lines.append(f"{i}. **{title}**")
                output_lines.append(f"   {url}")
                output_lines.append(f"   {snippet}\n")
            
            return ToolResult.ok(
                "\n".join(output_lines),
                query=query,
                count=len(results),
            )
            
        except ImportError:
            return ToolResult.fail(
                "ddgs not installed. Run: pip install ddgs"
            )
        except Exception as e:
            return ToolResult.fail(f"Search failed: {str(e)}")


class FetchURLTool(Tool):
    """
    Fetch content from a URL.
    
    Note: This is a placeholder. In production, you would use
    httpx or aiohttp to fetch and parse web pages.
    """
    
    @property
    def name(self) -> str:
        return "fetch_url"
    
    @property
    def description(self) -> str:
        return (
            "Fetch and read content from a URL. "
            "Returns the main text content of the page."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "url": {
                "type": "string",
                "description": "The URL to fetch",
            },
            "extract_main": {
                "type": "boolean",
                "description": "If true, extract only main content (remove nav, ads, etc.)",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["url"]
    
    async def execute(
        self,
        url: str,
        extract_main: bool = True,
    ) -> ToolResult:
        """Fetch URL content."""
        # Placeholder implementation
        # In production, use httpx + BeautifulSoup or similar
        return ToolResult.ok(
            f"[Fetch URL] URL: '{url}'\n"
            f"(URL fetching not configured. Integrate with httpx and BeautifulSoup)",
            url=url,
            provider="placeholder",
        )


# Export tools
TOOLS = [WebSearchTool(), FetchURLTool()]
