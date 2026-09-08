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
resume_prompt_file="${AGENTBOARD_RESUME_PROMPT_FILE:-}"

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
  # --absolute-git-dir, not --git-dir: a linked worktree's answer is only
  # correct relative to the worktree root, and by the time this runs $PWD may
  # already be somewhere else (a general task's cwd, an earlier `cd`).
  git_dir="$(git -C "$session_cwd" rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [[ -n "$git_dir" ]]; then
    exclude_file="$git_dir/info/exclude"
    # A linked worktree's own .git/worktrees/<name>/ has no info/ subdirectory
    # by default — only the main checkout's .git/info/ is guaranteed to exist.
    mkdir -p "$(dirname "$exclude_file")" 2>/dev/null || true
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

# agent_args is a shell-quoted argument list built by the daemon, not user
# free-text, so eval is what re-splits it back into distinct arguments.
eval "set -- $session_args $agent_args"

# The card's brief, handed to the agent CLI as its opening prompt.
#
# This is argv, not a paste into the pane. The daemon used to wait for the pane
# to look ready and then paste the brief in, which meant guessing at four things
# it could not observe — whether the CLI had started, whether it was listening,
# whether the text arrived intact, and whether Enter submitted it — and getting
# any one of them wrong left the brief sitting in the input box, unsubmitted,
# with the card silently doing nothing. argv has none of those failure modes:
# the kernel hands the string to the process before it runs, so there is no
# race to lose and no partial arrival to detect.
#
# The reason this was abandoned in 5c62f10 no longer holds. Two other bugs were
# in play then: the brief rode the command line typed into the pane, which the
# tty truncated at ~4 KB (fixed separately in d06977a, which moved the contents
# into a file so only this path travels through argv), and the CLI was not
# exec'd, so it was not the pane's foreground process (fixed in f9c6883).
# Re-verified directly against claude 2.1.263: a 42 KB brief containing quotes,
# $VARS, backticks and blank lines arrives byte-for-byte and is submitted
# without anything touching the pane.
#
# Appended after the eval above, which resets "$@".
#
# Only a fresh conversation gets it: replaying the brief into a --resume would
# hand the agent work it has already done. The file is removed either way, so a
# reopened card never re-reads a stale brief.
# Two files rather than one, because only this script knows which case it is
# in: the brief must never be replayed into a resumed conversation, while a
# queued message must be delivered in *both* cases — it is news either way.
#
# So the brief is conditional on a fresh start and the queued messages are
# unconditional, and the two are joined into a single positional argument
# because the agent CLI takes one. Both files are removed either way, so
# nothing is delivered twice.
#
# The messages used to be dropped outright on a fresh start: the branch below
# was gated on "$resuming" == 1 and the `rm -f` was not, so a card that opened
# fresh had its queue deleted from the database (by the daemon, at launch) and
# its file deleted from disk without either one being read. Comments here and
# in session-manager.ts both claimed a fresh start appended them to the brief.
# No code did. That was issue #46 §2.
prompt=""
if [[ -n "$initial_prompt_file" ]]; then
  if [[ "$resuming" != "1" && -f "$initial_prompt_file" ]]; then
    prompt="$(cat "$initial_prompt_file")"
  fi
  rm -f "$initial_prompt_file"
fi

if [[ -n "$resume_prompt_file" && -f "$resume_prompt_file" ]]; then
  if [[ -n "$prompt" ]]; then
    prompt="$prompt

$(cat "$resume_prompt_file")"
  else
    prompt="$(cat "$resume_prompt_file")"
  fi
  # A receipt, dropped only on the path where the contents actually made it
  # into "$prompt" and therefore into the argv this script is about to exec
  # with. The daemon holds the messages in its queue until it sees this file
  # and re-delivers them if it never appears, so nothing is lost to a pane
  # that dies before getting here.
  #
  # A receipt rather than "the notice file is gone": the notice is deleted on
  # every path, and its absence cannot tell "read it" apart from "never wrote
  # one" or "the daemon has not looked yet".
  : > "${resume_prompt_file}.read" 2>/dev/null || true
  rm -f "$resume_prompt_file"
fi

if [[ -n "$prompt" ]]; then
  set -- "$@" "$prompt"
fi

# exec, not a plain call: this is the last line of the script, nothing runs
# after it, so there is no reason to keep this process around as a wrapper.
# A plain call leaves bash sitting between the pane's shell and the agent,
# and tmux's own pane_current_command does not reliably walk through that
# extra layer to report the agent as the pane's foreground process — which
# is what the daemon's delivery pipeline (pane-idle.ts's
# waitForForegroundCommand) polls before pasting the card's brief in. Without
# exec here, a slow enough bootstrap step (a large git fetch on a shared,
# non-worktree checkout, confirmed live) can outlast that poll's timeout,
# and the brief gets pasted into whatever is still on screen instead of into
# the agent — verified as "delivered" even though nothing received it.
exec "$command_name" "$@"
