#!/usr/bin/env bash

set -euo pipefail

task_kind="${AGENTBOARD_TASK_KIND:-repo}"
repo_path="${AGENTBOARD_REPO_PATH:-}"
task_branch="${AGENTBOARD_TASK_BRANCH:-}"
base_branch="${AGENTBOARD_BASE_BRANCH:-main}"
session_cwd="${AGENTBOARD_SESSION_CWD:-${repo_path:-$HOME}}"
agent="${AGENTBOARD_AGENT:-claude}"
uses_worktree="${AGENTBOARD_USES_WORKTREE:-0}"
bootstrap_notice="${AGENTBOARD_BOOTSTRAP_NOTICE:-}"
agent_args="${AGENTBOARD_AGENT_ARGS:-}"
workspaces="${AGENTBOARD_WORKSPACES:-}"

# The card's checkouts, one "label<TAB>branch<TAB>path" row per line.
#
# The daemon ships them JSON-escaped so the separators survive the shell's
# double-quote parsing; printf %b turns "\t" and "\n" back into real ones.
print_workspace_banner() {
  [[ -n "$workspaces" ]] || return 0

  local label branch path
  printf 'Workspaces for this card:\n'
  while IFS=$'\t' read -r label branch path; do
    [[ -n "$path" ]] || continue
    printf '  %-24s %-36s %s\n' "$label" "$branch" "$path"
  done < <(printf '%b\n' "$workspaces")
  printf '\n'

  # Deliberately no cd between them: this is the one shell the agent runs in, and
  # the agent moves itself once it picks the checkout it wants to work in.
}

if [[ -n "$session_cwd" ]]; then
  cd "$session_cwd"
fi

if [[ -n "$bootstrap_notice" ]]; then
  printf '%b\n\n' "$bootstrap_notice"
  exit 0
fi

# A general task is attached to no repo, so there is no branch to check out.
if [[ "$task_kind" != "general" && "$uses_worktree" != "1" ]]; then
  git -C "$repo_path" checkout "$base_branch"
  git -C "$repo_path" pull
  git -C "$repo_path" checkout "$task_branch" 2>/dev/null || git -C "$repo_path" checkout -b "$task_branch"
fi

clear

# After the clear, not before it, or the screen wipe would eat the map the agent
# is meant to open on.
print_workspace_banner

case "$agent" in
  claude)
    command_name="claude"
    ;;
  codex)
    command_name="codex"
    ;;
  *)
    printf 'Unsupported agent CLI: %s\n' "$agent" >&2
    exit 1
    ;;
esac

if ! command -v "$command_name" >/dev/null 2>&1; then
  printf 'Agent CLI not found in PATH: %s\n' "$command_name" >&2
  exit 127
fi

if [[ -n "$agent_args" ]]; then
  # agent_args is a shell-quoted argument list built by the daemon, not user
  # free-text, so eval is what re-splits it back into distinct arguments.
  eval "\"\$command_name\" $agent_args"
else
  "$command_name"
fi
