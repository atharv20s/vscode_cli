# Agentic CLI and Autonomous AI Development Studio

This repository contains a unified AI-powered development ecosystem. It comprises two main components:
1. Agentic CLI: A Python-based terminal assistant with tool-calling capabilities, planning modes, and deep reasoning features.
2. Autonomous AI Development Studio: A Node.js and Express web server providing a browser-based IDE workspace with a live terminal, file explorer, code editor, and interactive AI agent composer.

## Architecture

The system architecture flow is described below:

```mermaid
graph TD
    subgraph Client ["Browser IDE Client"]
        UI["Explorer, Terminal, and Chat UI"]
        WSClient["WebSocket Client (app.js)"]
    end

    subgraph Server ["Node.js Backend Server"]
        Express["Express Server (server.js)"]
        WSServer["WebSocket Server (wsServer.js)"]
        TermMgr["Terminal Manager (terminalManager.js)"]
        AgentSvc["Agent Service (agentService.js)"]
        FileCtrl["File Controller (fileController.js)"]
    end

    subgraph System ["Local System & Environment"]
        PtyProcess["Persistent Shell Process"]
        PythonAgent["Python Agentic CLI (main.py)"]
        LLM["LLM APIs (Mistral / OpenRouter)"]
        Filesystem["Workspace Filesystem"]
    end

    UI -->|HTTP Requests| Express
    UI -->|Interactions| WSClient
    WSClient <-->|WebSockets (Ctrl+C, Stdout, Stdin)| WSServer
    Express --> FileCtrl
    FileCtrl <--> Filesystem
    WSServer <--> TermMgr
    TermMgr <-->|Shell I/O| PtyProcess
    AgentSvc -->|runAgent Loop| PythonAgent
    PythonAgent -->|Tool Calls| Filesystem
    PythonAgent -->|Completions| LLM
```

### Directory Structure

* Root directory: Holds the Python Agentic CLI codebase, setup files, and prompt configurations.
* Agent/: Core agent logic, state execution, and event handling.
* CLIENT/: Client integrations for LLMs (such as OpenRouter).
* tools/: Custom tool definitions for file editing, git control, search, and system execution.
* ui/: Terminal User Interface (TUI) rendering logic.
* server/: Node.js backend server hosting the web IDE, handling WebSockets, managing persistent terminal shell sessions, and exposing workspace APIs.
* server/public/: Static assets and frontend JavaScript logic for the browser IDE workspace.

## Technologies and Frameworks

The backend services utilize the following stack:
* Express: REST API routes for workspace management, GitHub flows, and security.
* WebSockets (ws): High-performance real-time terminal shell communication and interrupt packet routing.
* Redis (ioredis): Tier 1 distributed caching with automatic fallback mechanisms.
* In-Memory Caching (node-cache): Tier 2 zero-config local memory cache.
* Rate Limiting (express-rate-limit): Tailored endpoint rules for authorization, general requests, GitHub hooks, and agent routes.
* Databases (mysql2, better-sqlite3): Relational storage adapters for local SQLite and distributed MySQL instances.
* Python Click: Structured command-line interface runtime.

## Prerequisites

* Python 3.10 or higher
* Node.js 18.0 or higher
* npm (Node Package Manager)
* MySQL database server (required for production workspace configurations)

## Installation and Setup

### 1. Environment Configuration

Create a .env file in the server/ directory with the following variables:

```env
PORT=3001
MISTRAL_API_KEY=your_mistral_api_key
OPENROUTER_API_KEY=your_openrouter_api_key
MYSQL_HOST=localhost
MYSQL_USER=your_username
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=your_database
```

Make sure to also export the required Python environment variables in your command-line environment:

```bash
export OPENROUTER_API_KEY="your_openrouter_api_key"
```

### 2. Python Agentic CLI Setup

Install the package dependencies using setup.py or by installing the requirements:

```bash
pip install -e .
```

### 3. Server Setup

Navigate to the server directory, install the Node.js packages, and start the backend:

```bash
cd server
npm install
npm run dev
```

Once started, the Express server will boot up and host the Autonomous IDE studio at http://localhost:3001/.

## Usage

### 1. Python CLI Usage

You can run the Python CLI in different modes depending on the task:

* Interactive REPL mode:
  ```bash
  python main.py -i
  ```
* Running a specific task with tool execution enabled:
  ```bash
  python main.py -t "Analyze main.py and list all tool definitions"
  ```
* Planning mode (creates an implementation plan first):
  ```bash
  python main.py -m plan "Design a REST API structure"
  ```
* Deep reasoning mode:
  ```bash
  python main.py -m think "Solve the mathematical proof"
  ```

### 2. Browser IDE Studio Usage

Open http://localhost:3001/ in your browser. The interface contains three main areas:
* Left Sidebar: Live workspace file explorer allowing you to create, rename, edit, or delete files and folders.
* Bottom Panel: Interactive persistent terminal shell connected directly to the workspace server.
* Right Panel: AI composer interface where you can submit instructions to run agent execution loops.

## Interactive Terminal Management

The bottom terminal pane runs a persistent shell over WebSockets. Important terminal characteristics:
* Key Interrupts: Pressing Ctrl+C inside the terminal input bar triggers a signal (ASCII ETX character \x03) to the backend terminal process. This allows you to interrupt running processes (such as a python shell loop or a ping statement) without dropping the terminal session.
* Commands must be executed directly in the terminal input bar rather than entering them as prompts inside the AI Composer pane.
