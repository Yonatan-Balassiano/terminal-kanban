---
name: agentboard
description: Work with AgentBoard from inside an agent session — find your bearings on the board, spin off follow-up work as a linked subtask card and start its agent, message other cards' sessions, read fleet/attention state, recover a stuck session, and clean up without losing work. Use when creating or starting an AgentBoard card, handing work to another agent, checking on sessions you spawned, reviewing a subtask's PR, or when a card looks stuck or idle.
---

# Working with AgentBoard

AgentBoard is a terminal-native kanban board for AI coding sessions. A **card** is a unit of work; a **session** is an agent working it. You are (almost always) an agent running inside a card's session.

Three things are worth knowing up front, because they change what is safe to do:

- **A card's conversation is not in its pane.** It lives in the agent's own transcript, under a session id AgentBoard pins. So a pane can be replaced without losing anything.
- **A card's opening brief arrives on the agent CLI's argv at launch**, not by anything typing into the pane. It cannot be truncated or partially submitted.
- **A card's uncommitted work is archived, not deleted**, when the card is deleted or reaches done.

## Find your bearings

| Command | Answers |
|---|---|
| `agentboard ls` | What cards exist, and their ids |
| `agentboard fleet` | Every live session and its state — one call instead of poking N panes |
| `agentboard attention` | Which cards want a human right now, and why |
| `agentboard repos ls` | Repo ids/labels, for `--repo` |

Add `--json` to any of them when you need to parse the result.

Your own task id is in `AGENTBOARD_TASK_ID`, or in `.agentboard/task-id` in your worktree if a sandboxed shell dropped the env var.

## Spinning off follow-up work

Only create a card for **well-defined, ready-to-start** work. Don't fan out speculative subtasks, and don't create a card for your own internal housekeeping (a verification pass, a quick search) — those are subagents, not board cards.

### 1. Resolve inputs, don't guess

```bash
agentboard repos ls       # exact --repo <id>; a wrong one starts the session in the wrong checkout
agentboard ls             # is this already backlogged or in progress? don't duplicate
```

### 2. Write the mission to a file, then pass it both ways

```bash
mkdir -p "$TMPDIR/agentboard-missions"
cat > "$TMPDIR/agentboard-missions/rate-limiter.md" <<'EOF'
# Extract the rate limiter
Why: ...
Files: src/services/limiter.ts, tests/limiter.test.ts
Acceptance: `npm run test` green; no behaviour change
Out of scope: the retry policy — a separate card owns that
EOF

agentboard task create "Extract the rate limiter" \
  --repo terminal-kanban \
  --description "Your full brief is at $TMPDIR/agentboard-missions/rate-limiter.md — re-read it if you lose context." \
  --context-file "$TMPDIR/agentboard-missions/rate-limiter.md" \
  --start
```

`--context-file` inlines the file's contents into the opening prompt, so the agent has the whole brief immediately; the `--description` pointer means it can **re-read** the file after a compaction. Use both. Write the file to a stable path **outside any worktree**, so it survives that worktree being removed.

Brief the way you'd brief a stranger with zero context: why, the actual task, acceptance criteria, relevant paths, and what is explicitly out of scope.

### 3. Always pass `--start`

Every time, with no separate confirmation step. A card without `--start` sits idle in `backlog`, which defeats the point. `--start` is a daemon RPC — it works from a sandboxed shell, and you never need to drive tmux yourself.

## What you get for free

- **Auto-linking.** A card created from inside a running session is linked as a subtask of your card automatically — no flag. Use `--parent <id>` to link elsewhere. If a card comes out unlinked, run `task create` from inside your worktree (the fallback marker file is found by walking up from the cwd).
- **Session naming.** The subtask's session is named `<your session name>/<its title>`, so `ListAgents` shows the hierarchy with no lookup. Override with `--session-name`.
- **PR notification, two ways.** When the subtask's PR opens, your card is flagged on the board (durable, always correct) *and* the subtask is told to `SendMessage` you directly (prompt, but skippable). Trust the board flag; treat the message as a courtesy.
- **Your session stays alive until every subtask is done.** Even once your own branches have shipped, the board holds your card in `shipping` — not `done` — while any subtask you spun off is still open. `done` is what tears down a session and its worktree, so this is deliberate: it's often your session that's needed to check on or unblock a stuck subtask. Nothing to do here — it resolves itself the moment the last subtask reaches `done`.

## Talking to other sessions

| Direction | Primitive | Addressed by |
|---|---|---|
| Parent → subtask | `agentboard task notify <task-id> "..."` | **task id** |
| Subtask → parent | `SendMessage({to: "<session name>", ...})` | **session name** |

These are different identifiers — don't conflate them.

**A message is never lost, even if the card is closed.** `notify` reports one of three things:

| Outcome | Means | What to do |
|---|---|---|
| `delivered: true` | Typed into the live pane, confirmed on screen, and submitted | Nothing |
| `queued: true` | No live session, or the paste never landed — stored, and handed to that agent on its own argv the next time its session opens | Nothing. Don't re-send: it is waiting, and a second copy would be delivered too |
| `landedUnsubmitted: true` | The message is sitting in the pane's input box and no Enter would submit it | **Don't re-send** — that stacks a second copy under the first. `agentboard task restart <id>` replaces the pane, keeping the card, its branch, its worktree and its conversation |

So notifying a card that isn't running is a normal thing to do, not a failure. The message arrives in that agent's conversation whenever it next opens, attributed to the card that sent it.

A queued message stays queued until the session that opens actually reads it. If that pane dies first, the message is still there and the next open carries it — so "queued" really does mean waiting, not handed off and hoped for.

**`notify` appends to whatever is already in the input box.** There is no way to clear that box from outside — `C-u`, `Escape` and `C-c` all leave a pasted fragment untouched. If a pane's input is in a bad state, `agentboard task restart` it rather than trying to fix it in place.

## Reading `fleet`

| Column | Means |
|---|---|
| `BUSY` | The agent wrote to its conversation in the last couple of seconds. A liveness hint, not a lock — a card mid-model-call can briefly read `no` |
| `DELIVERY` | `verified` = the agent has a real user turn, so it got its brief. `-` = it hasn't written its first turn yet (unknown, **not** failed) |
| `TRUST-PROMPT` | `STUCK` means the trust dialog was never dismissed — that dismissal is automatic, so this is a real failure worth looking at |
| `PANE` | The tmux pane id. **Address panes by this, never by window index** — indices are renumbered as cards come and go, so a cached one silently points at a different card |

## When a card looks stuck

```bash
agentboard task restart <id>
```

Kills the pane and relaunches it, **keeping the card id, its branch, its worktree and its conversation**. This is the recovery path. Do not delete-and-recreate: that mints a new card id and rots every reference to it.

`agentboard task redeliver-prompt <id>` re-sends the stored brief into a live session. It is now rare — the brief rides argv, so there is no delivery to fail. It reports which of four things happened (`no-session`, `no-brief`, `not-verified`, `not-submitted`). `not-verified` is worth retrying; `not-submitted` means the brief is in the input box and only `agentboard task restart <id>` will clear it.

## Cleaning up

```bash
agentboard task delete <id>            # dry run: prints what would go
agentboard task delete <id> --force    # do it, archiving uncommitted work
agentboard task delete <id> --force --purge   # do it, destroying uncommitted work
```

`--force` means "don't ask me". `--purge` means "don't keep it". They are different decisions.

Without `--purge`, anything uncommitted in the worktree is committed and pinned to `refs/agentboard/archive/<task-id>` before removal, and the command prints how to read it back. So writing your findings into your worktree is safe — but a card you still care about is a card to `restart`, not delete.

## Verify before you relay

Don't take a subagent's review, investigation, or findings at face value because it came back confident. Before acting on it or reporting it to the user as settled, re-check the claim against the actual code or state — in a separate subagent if it is substantial.

That verification is internal housekeeping. It does **not** get its own board card.

## Anti-patterns

- Creating a card without `--start`.
- Driving `tmux send-keys` by hand. Everything you need is a CLI command; if you are reaching for tmux, you are working around something.
- `delete` + `create` to restart. Use `restart`.
- Caching a tmux window index. Use the pane id from `fleet`.
- Guessing `--repo`. Run `agentboard repos ls`.
- A card per speculative idea. One concrete, ready-to-start task per card.
