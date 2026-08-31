#!/usr/bin/env bash

set -euo pipefail

task_id="${AGENTBOARD_TASK_ID:-}"
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
agent_session_id="${AGENTBOARD_AGENT_SESSION_ID:-}"
initial_prompt_file="${AGENTBOARD_INITIAL_PROMPT_FILE:-}"

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

# Drop the card's own id on disk inside its worktree.
#
# AGENTBOARD_TASK_ID is exported into this pane's shell, and the agent CLI
# inherits it — but a Bash tool call the agent makes may run through its own
# sandbox that does not forward the outer process's environment, silently
# losing the id. `agentboard task create`'s subtask auto-link falls back to
# reading this file (walking up from $PWD) when the env var is missing, so a
# sandboxed shell still finds its parent instead of creating an orphaned card.
# Skipped for a general task: those all share $HOME as their cwd, where a
# single marker file would be ambiguous across every general task running at
# once.
if [[ "$task_kind" != "general" && -n "$task_id" && -d "$session_cwd" ]]; then
  mkdir -p "$session_cwd/.agentboard" 2>/dev/null || true
  printf '%s' "$task_id" > "$session_cwd/.agentboard/task-id" 2>/dev/null || true
  git_dir="$(git -C "$session_cwd" rev-parse --git-dir 2>/dev/null || true)"
  if [[ -n "$git_dir" ]]; then
    exclude_file="$git_dir/info/exclude"
    grep -qxF '.agentboard/' "$exclude_file" 2>/dev/null || printf '.agentboard/\n' >> "$exclude_file" 2>/dev/null || true
  fi
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

# Flags pinning the agent to this card's conversation.
#
# A card outlives whichever pane it was last opened in, so reopening one has to
# rejoin its conversation rather than start a blank agent. Resuming by id beats
# "the newest conversation in this directory": a card's second pane, and any
# sibling task sharing the checkout, all write their history to the same place.
#
# An id only becomes resumable once the agent has written it out, which does not
# happen until the first message — so a card that was opened and abandoned has
# nothing to resume, and starts its conversation under that same id instead.
#
# Only claude is wired up; codex's resume flags are not verified here, so it
# keeps launching the way it always has.
session_args=""
resuming=0
if [[ -n "$agent_session_id" && "$agent" == "claude" ]]; then
  claude_projects="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
  if compgen -G "$claude_projects/*/$agent_session_id.jsonl" >/dev/null 2>&1; then
    session_args="--resume $(printf '%q' "$agent_session_id")"
    resuming=1
  else
    session_args="--session-id $(printf '%q' "$agent_session_id")"
  fi
fi

# The card's brief file. It is no longer typed into argv here — a multi-line
# brief handed to the CLI as a positional argument depends on the CLI's own
# startup (its SessionStart hooks included) processing it correctly before the
# prompt is submitted, which is not reliable. The daemon delivers it instead,
# once this pane is up, by pasting it in directly (see TmuxBackend/SshTmuxBackend).
#
# Only a fresh conversation gets it: replaying the brief into a --resume would
# hand the agent work it has already done. Deleting the file here — rather
# than leaving it for the daemon to notice "this is a resume" itself — is the
# one signal both sides need: the daemon delivers the brief if and only if the
# file it wrote is still there once the pane comes up.
if [[ -n "$initial_prompt_file" && "$resuming" == "1" ]]; then
  rm -f "$initial_prompt_file"
fi

# agent_args is a shell-quoted argument list built by the daemon, not user
# free-text, so eval is what re-splits it back into distinct arguments.
eval "set -- $session_args $agent_args"

"$command_name" "$@"
