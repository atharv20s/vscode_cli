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
    
    Uses httpx for async HTTP requests and extracts readable text.
    Supports HTML pages, JSON APIs, and plain text.
    """
    
    def __init__(self, timeout: float = 30.0, max_content_length: int = 100_000):
        """
        Initialize the fetch tool.
        
        Args:
            timeout: Request timeout in seconds
            max_content_length: Max content to return (chars)
        """
        self.timeout = timeout
        self.max_content_length = max_content_length
    
    @property
    def name(self) -> str:
        return "fetch_url"
    
    @property
    def description(self) -> str:
        return (
            "Fetch and read content from a URL. "
            "Returns the text content of web pages, JSON from APIs, or raw text. "
            "Automatically extracts readable text from HTML pages."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "url": {
                "type": "string",
                "description": "The URL to fetch (must start with http:// or https://)",
            },
            "extract_text": {
                "type": "boolean",
                "description": "If true (default), extract readable text from HTML. If false, return raw content.",
            },
            "headers": {
                "type": "object",
                "description": "Optional custom HTTP headers as key-value pairs",
            },
        }
    
    @property
    def required_params(self) -> list[str]:
        return ["url"]
    
    async def execute(
        self,
        url: str,
        extract_text: bool = True,
        headers: dict[str, str] | None = None,
    ) -> ToolResult:
        """Fetch URL content."""
        import httpx
        
        # Validate URL
        if not url.startswith(("http://", "https://")):
            return ToolResult.fail(
                f"Invalid URL: must start with http:// or https://. Got: {url}"
            )
        
        # Default headers to look like a browser
        default_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        if headers:
            default_headers.update(headers)
        
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=True,
                headers=default_headers,
            ) as client:
                response = await client.get(url)
                response.raise_for_status()
                
                content_type = response.headers.get("content-type", "").lower()
                
                # Handle JSON responses
                if "application/json" in content_type:
                    import json
                    try:
                        data = response.json()
                        formatted = json.dumps(data, indent=2)
                        if len(formatted) > self.max_content_length:
                            formatted = formatted[:self.max_content_length] + "\n... (truncated)"
                        return ToolResult.ok(
                            f"📦 JSON Response from {url}:\n\n{formatted}",
                            url=url,
                            content_type="json",
                            status_code=response.status_code,
                        )
                    except Exception:
                        pass
                
                # Handle plain text
                if "text/plain" in content_type:
                    text = response.text[:self.max_content_length]
                    if len(response.text) > self.max_content_length:
                        text += "\n... (truncated)"
                    return ToolResult.ok(
                        f"📄 Text from {url}:\n\n{text}",
                        url=url,
                        content_type="text",
                        status_code=response.status_code,
                    )
                
                # Handle HTML
                if extract_text and "text/html" in content_type:
                    text = self._extract_text_from_html(response.text)
                    if len(text) > self.max_content_length:
                        text = text[:self.max_content_length] + "\n... (truncated)"
                    return ToolResult.ok(
                        f"🌐 Content from {url}:\n\n{text}",
                        url=url,
                        content_type="html",
                        status_code=response.status_code,
                    )
                
                # Raw content
                content = response.text[:self.max_content_length]
                if len(response.text) > self.max_content_length:
                    content += "\n... (truncated)"
                return ToolResult.ok(
                    f"📥 Raw content from {url}:\n\n{content}",
                    url=url,
                    content_type=content_type,
                    status_code=response.status_code,
                )
                
        except httpx.TimeoutException:
            return ToolResult.fail(f"Request timed out after {self.timeout}s: {url}")
        except httpx.HTTPStatusError as e:
            return ToolResult.fail(f"HTTP {e.response.status_code}: {url}")
        except httpx.RequestError as e:
            return ToolResult.fail(f"Request failed: {str(e)}")
        except Exception as e:
            return ToolResult.fail(f"Fetch failed: {str(e)}")
    
    def _extract_text_from_html(self, html: str) -> str:
        """Extract readable text from HTML, removing scripts, styles, and navigation."""
        import re
        
        # Remove script and style elements
        html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
        
        # Remove nav, header, footer, aside (common non-content areas)
        html = re.sub(r'<nav[^>]*>.*?</nav>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<header[^>]*>.*?</header>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<footer[^>]*>.*?</footer>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<aside[^>]*>.*?</aside>', '', html, flags=re.DOTALL | re.IGNORECASE)
        
        # Remove HTML comments
        html = re.sub(r'<!--.*?-->', '', html, flags=re.DOTALL)
        
        # Replace common block elements with newlines
        html = re.sub(r'<(p|div|br|h[1-6]|li|tr)[^>]*>', '\n', html, flags=re.IGNORECASE)
        
        # Remove all remaining HTML tags
        html = re.sub(r'<[^>]+>', '', html)
        
        # Decode common HTML entities
        html = html.replace('&nbsp;', ' ')
        html = html.replace('&amp;', '&')
        html = html.replace('&lt;', '<')
        html = html.replace('&gt;', '>')
        html = html.replace('&quot;', '"')
        html = html.replace('&#39;', "'")
        
        # Clean up whitespace
        lines = []
        for line in html.split('\n'):
            line = ' '.join(line.split())  # Normalize whitespace
            if line:
                lines.append(line)
        
        return '\n'.join(lines)


# Export tools
TOOLS = [WebSearchTool(), FetchURLTool()]
