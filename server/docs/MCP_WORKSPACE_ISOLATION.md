# MCP Workspace Isolation

## Overview

PR #62 completes the safety gate that was needed before the MCP filesystem
server could be enabled for multi-tenant use.  Every MCP filesystem tool call
is now routed through **WorkspaceMcpBridge**, which performs workspace-scoped
path validation before forwarding the request to the MCP server process.

## Why It Was Disabled

`mcp_config.json` shipped with `filesystem.enabled = false` because the MCP
filesystem server accepts arbitrary paths from the agent.  Without a validation
layer a compromised or misbehaving agent could read or write files outside its
assigned workspace — including other tenants' data or server credentials.

## What WorkspaceMcpBridge Adds

| Check | Detail |
|---|---|
| Absolute path rejection | Any path that starts with `/`, `C:\`, `\\`, etc. is rejected immediately — agents must use relative workspace paths only. |
| Null-byte blocking | Null bytes in paths are rejected before any syscall. |
| Symlink-safe resolution | `resolveSafeWorkspacePath` resolves each path component one segment at a time, calling `lstat` before each `join` and throwing if any intermediate segment is a symlink. |
| Canonical root check | After full resolution, `path.relative(canonicalRoot, resolved)` must not start with `..` and must not be absolute — both checks are applied. |
| Output truncation | Responses longer than 32,000 characters are trimmed at the bridge before they reach the agent. |
| Non-filesystem passthrough | Tools not in the filesystem category (e.g., `github_get_repo_info`) are forwarded without path inspection. |

## Enabled Tools

Only read-oriented filesystem tools are in the allowlist:

- `read_file`
- `read_multiple_files`
- `list_directory`
- `directory_tree`
- `get_file_info`
- `search_files`

Write tools (`write_file`, `create_directory`, `move_file`, `delete_file`) are
intentionally excluded from the allowlist.  Add them only after a workspace
backup / versioning strategy is in place.

## Integration

`WorkspaceMcpBridge` is not auto-wired by `initMcpServers`.  The WebSocket
session layer must construct a bridge per session:

```js
import { WorkspaceMcpBridge } from "../mcp/workspaceMcpBridge.js";

// Inside the authenticated ws handler, after workspace binding:
const bridge = new WorkspaceMcpBridge(
  session.workspaceRoot,
  async (toolName, args) => mcpTool(`mcp_filesystem_${toolName}`, args)
);

// Agent call site:
const result = await bridge.call("read_file", { path: "src/index.ts" });
```

## Remaining Gaps

| Gap | Priority |
|---|---|
| Write tool enablement | Medium — requires workspace versioning / rollback before safe to expose. |
| OS-level sandbox (seccomp / namespace) | High for production — Docker or cgroup isolation should wrap the npx MCP process. |
| Distributed process pool | Low — currently one MCP process per server instance; fine for single-node. |
| Audit logging of filesystem reads | Medium — log every file access through the bridge for compliance. |
