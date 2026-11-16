# External skills and MCP integrations

ATH IDE supports the Agent Skills directory convention and the Model Context Protocol (MCP).

## Import a skill from GitHub

The importer downloads one `SKILL.md` into `server/src/skills/<name>/SKILL.md`.
It uses GitHub's fixed HTTPS API endpoint, validates Agent Skills frontmatter, limits
the file to 32 KiB, rejects unsafe skill IDs and never executes imported content.

```bash
cd server
npm run skills:import -- anthropics/skills skills/pdf
npm run skills:import -- vercel-labs/agent-skills skills/react-best-practices
```

The path is repository-relative and may point to a skill directory or directly to
`SKILL.md`. An optional Git ref can be supplied before `--force`:

```bash
npm run skills:import -- owner/repo path/to/skill main
npm run skills:import -- owner/repo path/to/skill v1.2.0 --force
```

Imported skills must contain Agent Skills-compatible frontmatter with `name` and
`description`. The registry discovers valid skill directories automatically, so
no hard-coded catalog edit is needed. Existing built-in skills without frontmatter
continue to use their curated keyword catalog. Selection remains capped at four
skills and 32 KiB per skill.

Review imported instructions before enabling them in production. Skill text is
untrusted reference material and cannot grant permissions or override ATH IDE's
tool approval, workspace or security controls.

## MCP servers

ATH IDE already implements an MCP stdio client and server. Add trusted external
servers to `server/mcp_config.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["./path/to/server.js"],
      "transport": "stdio",
      "enabled": true,
      "allowedTools": ["read_file", "list_directory"]
    }
  }
}
```

- `enabled: false` skips a configured server.
- When `allowedTools` is present, only those exact upstream tool names are registered.
- Commands and arguments are passed directly to the child process; no shell is used.
- Child processes inherit only a small runtime environment allowlist. Pass required
  variables explicitly in that server's `env` object.
- MCP tool output is capped before it is returned to the agent.

The bundled filesystem server is disabled by default because the current MCP client
is process-global and cannot yet prove per-user workspace isolation. Keep it disabled
until the integration is made workspace-scoped. The bundled GitHub MCP server is
restricted to repository metadata lookup; other actions remain unavailable through
that connection.

MCP server configuration is privileged operator configuration because it starts
subprocesses. Only trusted administrators should change it. Prefer workspace-scoped
servers and read-only tool allowlists. Do not point a filesystem server at a shared
host directory or expose credentials unless the integration requires them and its
isolation has been reviewed.
