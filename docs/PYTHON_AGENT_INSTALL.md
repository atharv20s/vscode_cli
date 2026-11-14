# Install the Python agent runtime

The Python CLI is packaged as `ath-ide-agent` and exposes the
`ath-agent` command. It is separate from the JavaScript browser IDE server;
installing it does not deploy or start the web application.

## Linux installation

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install .
```

Configure the model provider:

```bash
export OPENROUTER_API_KEY="your-provider-key"
export OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
export OPENROUTER_MODEL="mistralai/devstral-2512:free"
```

Then run:

```bash
ath-agent --help
ath-agent --tools "Summarize the current project"
ath-agent --interactive --tools
```

The CLI's shell and file-write tools require the approval flow in the Python
agent. Approval is not a sandbox: run the CLI in a dedicated Linux account or
container with only the project workspace mounted. Never run it as root or
mount the Docker socket into an agent workspace.

Optional developer tools:

```bash
python -m pip install ".[dev]"
```
