#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_BIN="$ROOT_DIR/dist/bin/agentboard.js"
GO_TUI_BIN="$ROOT_DIR/dist-go/agentboard-tui"

REPO_PATH=""
REPO_LABEL=""
LINK_CLI=0
RUN_DOCTOR=1
START_DAEMON=1

usage() {
  cat <<'EOF'
Usage: bash scripts/bootstrap.sh [options]

Validates the local toolchain, installs dependencies, builds AgentBoard,
initializes local state, and optionally registers a first repo.

Options:
  --repo <path>       Register a repo after setup
  --label <label>     Label to use with --repo
  --link-cli          Run npm link so `agentboard` is available globally
  --skip-doctor       Skip the post-setup doctor check
  --skip-daemon       Skip starting the daemon
  -h, --help          Show this help text
EOF
}

install_hint() {
  local command_name="$1"

  case "$command_name" in
    node)
      echo "Install Node.js 24.x (for example with nvm: \`nvm install 24\`)."
      ;;
    npm)
      echo "Install npm (it is bundled with most Node.js distributions)."
      ;;
    git)
      echo "Install Git with your package manager before continuing."
      ;;
    go)
      echo "Install Go from https://go.dev/dl/ or your package manager."
      ;;
    *)
      echo "Install \`$command_name\` and re-run this script."
      ;;
  esac
}

require_command() {
  local command_name="$1"
  local hint="${2:-}"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Error: required command not found: $command_name" >&2
    if [[ -n "$hint" ]]; then
      echo "$hint" >&2
    fi
    exit 1
  fi
}

normalize_version_component() {
  local component="${1:-0}"
  component="${component%%[^0-9]*}"
  if [[ -z "$component" ]]; then
    component=0
  fi
  echo "$component"
}

version_gte() {
  local actual="${1#v}"
  local required="${2#v}"

  actual="${actual#go}"
  required="${required#go}"

  local IFS=.
  local -a actual_parts required_parts
  read -r -a actual_parts <<<"$actual"
  read -r -a required_parts <<<"$required"

  local max_len="${#actual_parts[@]}"
  if (( ${#required_parts[@]} > max_len )); then
    max_len="${#required_parts[@]}"
  fi

  local idx actual_part required_part
  for (( idx=0; idx<max_len; idx++ )); do
    actual_part="$(normalize_version_component "${actual_parts[idx]:-0}")"
    required_part="$(normalize_version_component "${required_parts[idx]:-0}")"

    if (( 10#$actual_part > 10#$required_part )); then
      return 0
    fi
    if (( 10#$actual_part < 10#$required_part )); then
      return 1
    fi
  done

  return 0
}

assert_file_exists() {
  local file_path="$1"
  local description="$2"

  if [[ ! -f "$file_path" ]]; then
    echo "Error: expected $description at $file_path" >&2
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

require_command node "$(install_hint node)"
require_command npm "$(install_hint npm)"
require_command git "$(install_hint git)"
require_command go "$(install_hint go)"

cd "$ROOT_DIR"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "Error: AgentBoard requires Node.js >= 24 (found $(node -v))" >&2
  exit 1
fi

GO_REQUIRED_VERSION="$(awk '/^go / { print $2; exit }' "$ROOT_DIR/go.mod")"
if [[ -z "$GO_REQUIRED_VERSION" ]]; then
  echo "Error: could not determine required Go version from go.mod" >&2
  exit 1
fi

GO_VERSION_RAW="$(go env GOVERSION 2>/dev/null || true)"
if [[ -z "$GO_VERSION_RAW" ]]; then
  GO_VERSION_RAW="$(go version | awk '{ print $3 }')"
fi

if ! version_gte "$GO_VERSION_RAW" "$GO_REQUIRED_VERSION"; then
  echo "Error: AgentBoard requires Go >= $GO_REQUIRED_VERSION (found $GO_VERSION_RAW)" >&2
  echo "$(install_hint go)" >&2
  exit 1
fi

echo "==> Checking required tools"
echo "Node: $(node -v)"
echo "npm: $(npm -v)"
echo "Git: $(git --version)"
echo "Go:  $GO_VERSION_RAW"

echo "==> Installing npm dependencies"
npm install

echo "==> Building AgentBoard"
npm run build

assert_file_exists "$CLI_BIN" "CLI entry point"
assert_file_exists "$GO_TUI_BIN" "Go TUI binary"

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
