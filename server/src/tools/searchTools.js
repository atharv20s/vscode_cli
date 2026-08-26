/**
 * Search Tools — AI-optimized web search via Tavily.
 *
 * Replaces DuckDuckGo with Tavily for better quality results
 * optimized for LLM consumption.
 */

import { registerTool } from "./index.js";
import { config } from "../config/env.js";

export function registerSearchTools() {
  // ---- web_search ----
  registerTool(
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web for information using Tavily AI Search. " +
          "Returns relevant results with titles, URLs, and content snippets. " +
          "Optimized for AI agents — results are pre-processed for LLM consumption.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
            num_results: {
              type: "integer",
              description: "Number of results (default: 5, max: 10)",
            },
            search_depth: {
              type: "string",
              enum: ["basic", "advanced"],
              description: "Search depth — 'basic' (1 credit) or 'advanced' (2 credits)",
            },
          },
          required: ["query"],
        },
      },
    },
    async (args) => {
      if (!config.tavilyKey) {
        return {
          success: false,
          error: "TAVILY_API_KEY not configured. Set it in your .env file.",
        };
      }

      try {
        // Dynamic import to avoid crash if not installed
        const { tavily } = await import("@tavily/core");
        const client = tavily({ apiKey: config.tavilyKey });

        const maxResults = Math.min(args.num_results || 3, 5);
        const response = await client.search(args.query, {
          maxResults,
          searchDepth: args.search_depth || "basic",
          includeAnswer: true,
        });

        // Format concise results for LLM consumption
        let output = "";

        if (response.answer) {
          output += `**AI Summary:** ${response.answer}\n\n`;
        }

        if (response.results && response.results.length > 0) {
          output += response.results
            .slice(0, 3)
            .map(
              (r, i) =>
                `[${i + 1}] ${r.title} (${r.url})\n${(r.content || "").slice(0, 250)}...`
            )
            .join("\n\n");
        } else if (!response.answer) {
          output = `No results found for: "${args.query}"`;
        }

        return { success: true, output: output.trim() };
      } catch (err) {
        return { success: false, error: `Search failed: ${err.message}` };
      }
    }
  );

  // ---- web_extract ----
  registerTool(
    {
      type: "function",
      function: {
        name: "web_extract",
        description:
          "Extract the full content from a web page URL. " +
          "Returns cleaned text content suitable for analysis.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to extract content from" },
          },
          required: ["url"],
        },
      },
    },
    async (args) => {
      if (!config.tavilyKey) {
        return {
          success: false,
          error: "TAVILY_API_KEY not configured. Set it in your .env file.",
        };
      }

      try {
        const { tavily } = await import("@tavily/core");
        const client = tavily({ apiKey: config.tavilyKey });

        const response = await client.extract([args.url]);

        if (response.results && response.results.length > 0) {
          const result = response.results[0];
          return {
            success: true,
            output: `**URL:** ${result.url}\n\n${result.rawContent || result.content || "No content extracted."}`,
          };
        }

        return { success: false, error: "Failed to extract content from URL." };
      } catch (err) {
        return { success: false, error: `Extraction failed: ${err.message}` };
      }
    }
  );
}
