# ATH IDE — Autonomous AI Development Studio

ATH IDE is an event-driven, autonomous AI-first pair programming and terminal IDE. It bridges interactive pseudo-terminals (PTY), sandboxed background execution, real-time live application previewing, native filesystem watching, Git worktree isolation, multimodal vision, visual asset generation, and fine-grained security policies into a unified browser-based studio.

---

## Architecture Overview

```
                         +-----------------------+
                         |       CHAT / AGENT    |
                         +-----------+-----------+
                                     |
                              Agent Orchestrator
                                     |
                              Permission Engine
                                     |
                                Tool Router
                                     |
          +--------------+-----------+---------------+---------------+
          |              |           |               |               |
          v              v           v               v               v
      TERMINAL         FILES       GIT/GITHUB       MCP           PREVIEW
          |              |           |               |               |
          +--------------+-----------+---------------+---------------+
                                     |
                              Execution Service
                                     |
                    +----------------+-----------------+
                    |                                  |
                    v                                  v
             LOCAL BACKEND                       CLOUD BACKEND
                    |                                  |
              Windows PC                         Kubernetes
                    |                                  |
          +---------+---------+                 +------+------+
          v         v         v                 v      v      v
      PowerShell   CMD     Git Bash/WSL       Shell   Files  Processes
          |         |         |
          +---------+---------+
                    |
                  node-pty
                    |
                 Windows

And everything publishes events into one state system:

Terminal -----+
Files --------+
Git ----------+
MCP ----------+---> EVENT BUS ---> WORLD STATE ---> CHAT/UI
Preview ------+
Processes ----+
Agent --------+
```

---

## Key Features

### 1. Three-Tier Execution Isolation
* **USER_INTERACTIVE**: Dedicated pseudo-terminal (node-pty) connected to Xterm.js for interactive user shells (PowerShell 7, Windows PowerShell, CMD, Git Bash, WSL).
* **AGENT_BACKGROUND**: Isolated child process runner supervised by `ProcessSupervisor`. Runs tools such as `npm test`, `git status`, or dev servers without polluting the active terminal.
* **AGENT_INTERACTIVE**: Dedicated PTY allocated specifically for autonomous agent workflows (REPLs, Python interactive sessions, CLI prompts).

### 2. Central World State Service (`worldStateService.js`)
Aggregates live environmental state across all subsystems:
* **Workspace**: Root path, directory tree version, active files.
* **Terminal**: Shell type, current working directory, process state, foreground process, active network ports, exit codes, recent error logs, output tail.
* **Live Preview**: Status (`stopped`, `starting`, `running`, `failed`), command, active port, URL, process PID.
* **Git**: Active branch, uncommitted diff changes, staged files, last commit info.
* **Permissions**: Active policy rules and pending approvals.

### 3. Universal Permission Engine (`permissionEngine.js`)
All tool invocations and commands pass through a strict security matrix: `DENY > ASK > ALLOW`.
* **DENY**: Destructive commands (`rm -rf /`, `format`, `del /s /q c:\`, `git push --force`).
* **ASK**: Sensitive operations (`git push`, `npm publish`, deleting files). Dispatches `permission.requested` events and awaits user approval via WebSocket.
* **ALLOW**: Safe read/write operations within workspace root and development commands.

### 4. Process Supervisor & Process Tree Termination (`processSupervisor.js`)
Tracks background processes, captures real-time outputs, and prevents orphaned processes and port collisions by terminating entire process trees (`taskkill /pid <PID> /t /f` on Windows and `-PID` process groups on POSIX).

### 5. Live Application Preview Service (`previewService.js`)
Monitors dev-server stdout/stderr, extracts localhost URLs and ports via regular expressions (`http://localhost:XXXX`), confirms HTTP readiness, and publishes `preview.ready` events to automatically open the live preview pane.

### 6. Multimodal Vision & Image Attachments
* Attach screenshots, mockups, or diagrams via file upload, drag-and-drop, or clipboard paste (`Ctrl+V`).
* Automatically routes image payloads to multimodal Vision models (Pixtral 12B, Mistral Large, GPT-4o, Gemini 1.5 Flash).

### 7. AI Visual Asset Generation & Planning Tools
* **`generate_image`**: Generates responsive SVG diagrams, vector graphics, and UI mockups directly into `workspace/assets/`.
* **`analyze_image`**: Reads and analyzes image metadata in the workspace.
* **`create_plan`** & **`update_plan`**: Writes structured implementation roadmaps (`implementation_plan.md` and `task.md`) and tracks checklists across multi-turn agent tasks.

### 8. Native Workspace Service & File Watching (`workspaceService.js`)
Centralized filesystem controller with path sandboxing and debounced native file watching (`fs.watch`), emitting lightweight mutation events (`file.created`, `file.changed`, `file.deleted`, `file.renamed`) when external editors modify files.

### 9. Git Service & Worktree Isolation (`gitService.js`, `worktreeManager.js`)
First-class Git operations (`status`, `diff`, `log`, `commit`, `push`, `restore`). Supports creating isolated Git worktrees (`.worktrees/agent-<id>`) so agents can test experimental changes without altering the user's primary working directory.

---

## Tool Catalog

| Tool Name | Category | Description |
|---|---|---|
| `read_file` | Workspace | Read file contents with optional line slicing (`start_line`, `end_line`). |
| `write_file` | Workspace | Create or overwrite a file in the workspace. |
| `edit_file` | Workspace | Search-and-replace exact code strings in a file. |
| `list_files` | Workspace | List directory contents and subdirectories with file sizes. |
| `run_command` | Shell | Execute shell commands in isolated background mode. |
| `start_preview` | Preview | Start a dev-server background process, extract active port, and verify HTTP readiness. |
| `stop_preview` | Preview | Terminate active dev-server process tree and release port. |
| `get_preview_status` | Preview | Query current preview server state, port, and URL. |
| `generate_image` | Visual | Create SVG vector graphics, UI mockups, and diagrams in `workspace/assets/`. |
| `analyze_image` | Visual | Retrieve file format and metadata for workspace images. |
| `create_plan` | Planning | Create structured implementation plans and task checklists in `implementation_plan.md`. |
| `update_plan` | Planning | Update task status items in `task.md`. |
| `git_status` | Version Control | Inspect branch name, modified, untracked, and staged files. |
| `git_diff` | Version Control | View unstaged or staged unified diffs. |
| `git_log` | Version Control | Show recent commit history. |
| `git_commit` | Version Control | Stage changes and create a commit. |
| `git_push` | Version Control | Push committed changes to remote repository (requires permission approval). |
| `web_search` | Search | Query real-time search engines for technical documentation and libraries. |

---

## Getting Started

### Prerequisites
* Node.js v18+ (tested on Node.js v20 and v24)
* PowerShell / Bash / CMD
* Git

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/atharv20s/vscode_cli.git
   cd vscode_cli
   ```

2. Install backend dependencies:
   ```bash
   cd server
   npm install
   ```

3. Configure environment variables in `server/.env`:
   ```env
   PORT=3001
   MISTRAL_API_KEY=your_mistral_api_key_here
   OPENROUTER_API_KEY=your_openrouter_api_key_here
   WORKSPACE_ROOT=./workspace
   ```

4. Start the server:
   ```bash
   node src/server.js
   ```

5. Open your browser and navigate to:
   ```
   http://localhost:3001/
   ```

---

## Event Bus Topics & Taxonomy

All subsystems communicate through standardized event envelopes on the central EventBus:

* **Terminal**: `terminal.session.created`, `terminal.state`, `terminal.input`, `terminal.keystroke`, `terminal.command.submitted`, `terminal.output`, `terminal.resize`, `terminal.exit`
* **Agent Commands**: `agent.command.requested`, `agent.command.started`, `agent.command.output`, `agent.command.completed`, `agent.command.failed`, `agent.command.stopped`
* **Filesystem**: `file.created`, `file.changed`, `file.deleted`, `file.renamed`
* **Live Preview**: `preview.started`, `preview.ready`, `preview.output`, `preview.stopped`, `preview.failed`
* **Permissions**: `permission.requested`, `permission.resolved`

---

## Security & Path Policy

* **Sandboxing**: All filesystem mutations, shell commands, and read requests validate that resolved paths reside strictly within `config.workspaceRoot`.
* **Process Termination**: Background processes are registered in a central registry and destroyed with complete sub-process tree termination to ensure no orphaned processes occupy network ports.
* **Credential Vault**: Cloud GitHub tokens and API keys are stored securely server-side and never exposed to the client interface.

---

## License

MIT License. Developed for autonomous agentic software development workflows.
