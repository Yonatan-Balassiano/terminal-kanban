---
name: spawn-subtask
description: Create a follow-up AgentBoard card for well-defined work spun off from the current task. Cards created this way are auto-linked as subtasks of the running task and given a hierarchy-naming session name (SendMessage/ListAgents), the parent gets notified when the subtask's PR opens, and after reviewing it the parent can ping the subtask back to address comments.
---

# Spawn a sub-task on AgentBoard

Use when the current task has concrete, ready-to-start follow-up work that deserves its own card, via `agentboard task create <title> ...`.

## 1. Resolve inputs, don't guess

- `agentboard repos` → the exact `--repo <id>` (or `--pillar <ref>` if it's not the repo default).
- Check the board for an existing backlog/in-progress card already covering this — don't duplicate.

## 2. Write the mission to a file — keep `--description` to a pointer

`--description` becomes the new agent's *entire* opening prompt, delivered by the daemon pasting it into the fresh pane once the pane comes up. A long, multi-paragraph brief pasted inline is exactly what gets cut off or partially submitted on a slow/busy session start — the more text in that one paste, the more exposed it is. Don't inline the mission itself:

1. Write the full brief — the why, the actual task, acceptance criteria/tests, relevant file paths, and what's explicitly out of scope — to a plain markdown file, the way you'd brief a stranger with zero context. Use a stable path outside any worktree, so it survives regardless of which repo/worktree the subtask ends up in, e.g. `$TMPDIR/agentboard-missions/<slug>.md` (mirrors how AgentBoard's own daemon hands off large briefs via a file rather than argv — see `session-brief.ts`).
2. Pass `--description` with just a short pointer message: the agentboard ids are already added automatically for a subtask (see step 4) — nothing extra to write there — so this only needs one line naming the mission file's absolute path and telling the agent to read it first, e.g. `Your full brief is at /tmp/agentboard-missions/rate-limiter.md — read it before doing anything else.`
3. Do this *before* calling `agentboard task create`, so the path exists by the time the new session comes up and tries to read it.

The subtask's first action ends up being a `Read` of that file, not parsing a wall of pasted text — much cheaper to deliver reliably, and easy to re-point at (`agentboard task redeliver-prompt`) without re-typing the whole mission if delivery still needs a nudge.

## 3. Always pass `--start`

Always launch the subtask's agent immediately — pass `--start` every time, with no separate confirmation step. Creating the card without `--start` just leaves it idle in `backlog`, which defeats the point of spawning it.

The daemon delivers the brief itself in the background once the session starts — it waits for the pane to settle and the agent CLI (not a shell mid-bootstrap) to actually be in the foreground, pastes the brief in, confirms the brief's own opening text actually rendered before trusting it (re-pasting up to a few times if not — never just guessing a fixed delay was enough), then sends Enter and verifies the submit took, retrying for several minutes if not. If the paste never verifies, it deliberately leaves the pane unsubmitted rather than risking a mangled fragment reaching the agent as its first message — so there's no need to verify or hand-deliver the prompt yourself the way earlier versions of this skill instructed. A very slow agent-CLI startup (a slow SessionStart hook chain) can occasionally still outlast that window; if a session comes up idle with the brief sitting unsubmitted (or never showed up at all), run `agentboard task redeliver-prompt <its task id>` rather than typing it in by hand — that's the supported way to nudge it, not a workaround.

## 4. What comes for free

A card created this way — from inside a running session, with no extra flag — is automatically linked as a subtask of the task that spawned it, shown on the board with a badge naming its parent (e.g. `↳ Add rate limiting`), not just a bare "Subtask" — with two different parents each running subtasks, you can tell which is whose at a glance. Pass `--parent <id>` instead to link it to a different card explicitly.

Auto-linking has two paths so it survives a sandboxed Bash tool call losing the env var: `AGENTBOARD_TASK_ID` first, then a `.agentboard/task-id` marker file dropped in the worktree, found by walking up from the current directory. If a card still comes out unlinked, run `agentboard task create` from inside the worktree (not some unrelated cwd) — the marker file only helps if you're somewhere under it.

When the subtask's PR first opens, the parent learns about it two ways. First, durably: the parent card is flagged (`child_pr_alert_task_id`) regardless of whether either session is still running — this is the source of truth, and it's what you'll see on the board if you missed the second path. Second, promptly: the subtask's own opening brief tells it to `SendMessage` its parent session directly the moment it opens the PR, naming the PR number/URL and a one-line summary — no daemon involvement, just one running agent messaging another by session name. The second path can be missed (the parent's session may not be running, or may be mid-task when the message arrives) or, rarely, skipped by the subtask agent — which is exactly why the board flag exists as the durable fallback; check the board if you're not sure a subtask's PR notice reached you. If a `SendMessage` from a subtask does arrive mid-task, finish the step you're on but don't drop it — get to the review before ending your turn.

The board flag also resolves itself now — it clears automatically once that PR merges or closes, or once the subtask card itself reaches done, whichever happens first. You'll never see a stale badge for a subtask you've already dealt with; a badge still showing means there's genuinely still something to look at.

The parent card's PR list (`Shift+E` in the TUI) rolls up its subtasks' PRs too, each such row named with its own owning task (e.g. `↳ Extracted helper`) — reviewing a card's PRs surfaces everything it spawned, not just its own branch, and with more than one subtask you can tell which PR is whose. Every action in that picker (open, merge, comment) already resolves against the branch's actual owning task, so acting on a subtask's row from the parent's picker works the same as acting on it directly.

## 5. It also gets a session name — SendMessage works out of the box

The subtask's session launches with an explicit `--name`: the title by default, prefixed with your own session name (e.g. `Add rate limiting/Extract the limiter`), so `ListAgents` shows the hierarchy directly — no need to guess who is whose. Pass `--session-name <name>` to choose it yourself instead of the derived default. Its opening prompt is told both session names (yours and its own) plus its own task id — so it already knows how to message you back (`SendMessage({to: "<your session name>", ...})`) and how you'd notify it (`agentboard task notify <its task id> "..."`, a different identifier from the session name — don't conflate the two).

## 6. After reviewing a subtask's PR, tell it what to fix

Reviewing (step 4) is not the end of the loop — a review that finds something is only useful once the subtask actually sees it. After leaving PR comments (`gh pr review --request-changes` or similar) that need action, send the subtask a message pointing at them:

```bash
agentboard task notify <subtask-id> "Address the PR comments on #<pr-number>."
```

This delivers the message into the subtask's live session via the daemon — a different path from the `SendMessage` the subtask used to reach you about its PR, but the same idea in reverse: `agentboard task notify` is the parent-to-subtask primitive (addressed by task id), `SendMessage` is the subtask-to-parent one (addressed by session name). It goes through the same verified paste-and-confirm delivery the initial brief uses now, not a raw unverified type, and the response's `delivered` field is honest — `false` means the message genuinely never landed (nothing garbled was submitted either), not that it silently worked; if you get `false` back, wait a beat for the pane to settle and retry rather than assuming the subtask saw it. Skip it if your review had nothing to request changes on; don't ping a subtask just to say "looks good."

## Verifying what a subtask (or any subagent) reports back

Don't take a subagent's review, investigation, or findings at face value just because it came back confident. Before acting on it or relaying it to the user as settled fact, verify it yourself in a separate internal subagent (a `fork`, or a fresh general-purpose agent) — have it re-check the claim against the actual code/state rather than re-reading the same report.

This verification pass is internal housekeeping, not new work: it does **not** get its own AgentBoard card via `agentboard task create`. Only spin up a board card for follow-up work that's actually worth tracking on the board.
