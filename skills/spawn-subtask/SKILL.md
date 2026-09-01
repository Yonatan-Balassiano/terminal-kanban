---
name: spawn-subtask
description: Create a follow-up AgentBoard card for well-defined work spun off from the current task. Cards created this way are auto-linked as subtasks of the running task and given a hierarchy-naming session name (SendMessage/ListAgents), the parent gets notified when the subtask's PR opens, and after reviewing it the parent can ping the subtask back to address comments.
---

# Spawn a sub-task on AgentBoard

Use when the current task has concrete, ready-to-start follow-up work that deserves its own card, via `agentboard task create <title> ...`.

## 1. Resolve inputs, don't guess

- `agentboard repos` → the exact `--repo <id>` (or `--pillar <ref>` if it's not the repo default).
- Check the board for an existing backlog/in-progress card already covering this — don't duplicate.

## 2. Write the brief for a stranger

`--description` / `--context-file` becomes the new agent's *entire* opening prompt — it shares none of the current conversation. State the why, the relevant file paths, and what's explicitly out of scope.

## 3. Always pass `--start`

Always launch the subtask's agent immediately — pass `--start` every time, with no separate confirmation step. Creating the card without `--start` just leaves it idle in `backlog`, which defeats the point of spawning it.

The daemon delivers the brief itself once the session starts — it waits for the pane to settle, then pastes it in — so there's no need to verify or hand-deliver the prompt yourself the way earlier versions of this skill instructed. If a session still comes up with an empty prompt despite that, treat it as a bug in AgentBoard, not something to route around.

## 4. What comes for free

A card created this way — from inside a running session, with no extra flag — is automatically linked as a subtask of the task that spawned it, shown on the board with a badge naming its parent (e.g. `↳ Add rate limiting`), not just a bare "Subtask" — with two different parents each running subtasks, you can tell which is whose at a glance. Pass `--parent <id>` instead to link it to a different card explicitly.

Auto-linking has two paths so it survives a sandboxed Bash tool call losing the env var: `AGENTBOARD_TASK_ID` first, then a `.agentboard/task-id` marker file dropped in the worktree, found by walking up from the current directory. If a card still comes out unlinked, run `agentboard task create` from inside the worktree (not some unrelated cwd) — the marker file only helps if you're somewhere under it.

When the subtask's PR first opens, the parent card is flagged so its author knows to review it, and — if the parent still has a live session, in whichever repo that card belongs to — the notice is typed straight into that session's pane as a self-contained, self-directing message (it names itself as automated and spells out the `gh pr` commands to run). If you receive one of these mid-task, finish the step you're on but don't drop it — get to the review before ending your turn.

The parent card's PR list (`Shift+E` in the TUI) rolls up its subtasks' PRs too, each such row named with its own owning task (e.g. `↳ Extracted helper`) — reviewing a card's PRs surfaces everything it spawned, not just its own branch, and with more than one subtask you can tell which PR is whose. Every action in that picker (open, merge, comment) already resolves against the branch's actual owning task, so acting on a subtask's row from the parent's picker works the same as acting on it directly.

## 5. It also gets a session name — SendMessage works out of the box

The subtask's session launches with an explicit `--name`: the title by default, prefixed with your own session name (e.g. `Add rate limiting/Extract the limiter`), so `ListAgents` shows the hierarchy directly — no need to guess who is whose. Pass `--session-name <name>` to choose it yourself instead of the derived default. Its opening prompt is told both session names (yours and its own) plus its own task id — so it already knows how to message you back (`SendMessage({to: "<your session name>", ...})`) and how you'd notify it (`agentboard task notify <its task id> "..."`, a different identifier from the session name — don't conflate the two).

## 6. After reviewing a subtask's PR, tell it what to fix

Reviewing (step 4) is not the end of the loop — a review that finds something is only useful once the subtask actually sees it. After leaving PR comments (`gh pr review --request-changes` or similar) that need action, send the subtask a message pointing at them:

```bash
agentboard task notify <subtask-id> "Address the PR comments on #<pr-number>."
```

This types the message straight into the subtask's live session, the same mechanism used for the PR-opened notice above — it's a general "ping another card's session" primitive, not specific to this one flow. Skip it if your review had nothing to request changes on; don't ping a subtask just to say "looks good."

## Verifying what a subtask (or any subagent) reports back

Don't take a subagent's review, investigation, or findings at face value just because it came back confident. Before acting on it or relaying it to the user as settled fact, verify it yourself in a separate internal subagent (a `fork`, or a fresh general-purpose agent) — have it re-check the claim against the actual code/state rather than re-reading the same report.

This verification pass is internal housekeeping, not new work: it does **not** get its own AgentBoard card via `agentboard task create`. Only spin up a board card for follow-up work that's actually worth tracking on the board.
