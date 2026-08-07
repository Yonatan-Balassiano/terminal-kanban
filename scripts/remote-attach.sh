#!/usr/bin/env bash

set -euo pipefail

host="${1:-${AGENTBOARD_REMOTE_HOST:-}}"
session="${2:-${AGENTBOARD_REMOTE_SESSION:-}}"
control_path="${3:-${AGENTBOARD_SSH_CONTROL_PATH:-}}"

if [[ -z "$host" || -z "$session" ]]; then
  printf 'usage: remote-attach.sh <ssh-host> <tmux-session> [ssh-control-path]\n' >&2
  exit 2
fi

initial_backoff_seconds=1
max_backoff_seconds=30
# A connection that lasted this long was a real session, not a failing retry.
stable_connection_seconds=30

ssh_options=(-o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
if [[ -n "$control_path" ]]; then
  # Share the daemon's ControlMaster socket so attaching costs no extra handshake.
  ssh_options+=(-o "ControlPath=$control_path" -o ControlMaster=auto -o ControlPersist=300)
fi

backoff=$initial_backoff_seconds

while true; do
  printf 'agentboard: attaching to %s on %s...\n' "$session" "$host"

  connected_at=$SECONDS
  status=0
  ssh "${ssh_options[@]}" -t "$host" -- tmux attach-session -t "$session" || status=$?

  if [[ $status -eq 0 ]]; then
    # The user detached on purpose; the remote session keeps running.
    exit 0
  fi

  if (( SECONDS - connected_at >= stable_connection_seconds )); then
    backoff=$initial_backoff_seconds
  fi

  printf '\nagentboard: lost %s on %s (exit %d). reconnecting in %ds...\n' \
    "$session" "$host" "$status" "$backoff"
  sleep "$backoff"

  backoff=$(( backoff * 2 ))
  if (( backoff > max_backoff_seconds )); then
    backoff=$max_backoff_seconds
  fi
done
