#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_BIN="$ROOT_DIR/dist/bin/agentboard.js"

REPO_PATH=""
REPO_LABEL=""
LINK_CLI=0
RUN_DOCTOR=1
START_DAEMON=1

usage() {
  cat <<'EOF'
Usage: bash scripts/bootstrap.sh [options]

Installs dependencies, builds AgentBoard, initializes local state, and
optionally registers a first repo.

Options:
  --repo <path>       Register a repo after setup
  --label <label>     Label to use with --repo
  --link-cli          Run npm link so `agentboard` is available globally
  --skip-doctor       Skip the post-setup doctor check
  --skip-daemon       Skip starting the daemon
  -h, --help          Show this help text
EOF
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required command not found: $command_name" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_PATH="${2:-}"
      shift 2
      ;;
    --label)
      REPO_LABEL="${2:-}"
      shift 2
      ;;
    --link-cli)
      LINK_CLI=1
      shift
      ;;
    --skip-doctor)
      RUN_DOCTOR=0
      shift
      ;;
    --skip-daemon)
      START_DAEMON=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -n "$REPO_LABEL" && -z "$REPO_PATH" ]]; then
  echo "Error: --label requires --repo" >&2
  exit 1
fi

require_command node
require_command npm

cd "$ROOT_DIR"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Error: AgentBoard requires Node.js >= 20 (found $(node -v))" >&2
  exit 1
fi

echo "==> Installing npm dependencies"
npm install

echo "==> Building AgentBoard"
npm run build

echo "==> Initializing AgentBoard"
node "$CLI_BIN" init

if [[ "$LINK_CLI" -eq 1 ]]; then
  echo "==> Linking CLI"
  npm link
fi

if [[ "$START_DAEMON" -eq 1 ]]; then
  echo "==> Starting daemon"
  node "$CLI_BIN" daemon start
fi

if [[ -n "$REPO_PATH" ]]; then
  if [[ ! -d "$REPO_PATH" ]]; then
    echo "Error: repo path does not exist: $REPO_PATH" >&2
    exit 1
  fi

  echo "==> Registering repo: $REPO_PATH"
  if [[ -n "$REPO_LABEL" ]]; then
    node "$CLI_BIN" repos add "$REPO_PATH" --label "$REPO_LABEL"
  else
    node "$CLI_BIN" repos add "$REPO_PATH"
  fi
fi

if [[ "$RUN_DOCTOR" -eq 1 ]]; then
  echo "==> Running doctor"
  node "$CLI_BIN" doctor
fi

echo
echo "AgentBoard setup complete."
if [[ "$LINK_CLI" -eq 1 ]]; then
  echo "Launch with: agentboard"
else
  echo "Launch with: node dist/bin/agentboard.js"
  echo "Or link the CLI later with: npm link"
fi

if [[ -z "$REPO_PATH" ]]; then
  echo "Register a repo with: node dist/bin/agentboard.js repos add /absolute/path/to/repo"
fi
