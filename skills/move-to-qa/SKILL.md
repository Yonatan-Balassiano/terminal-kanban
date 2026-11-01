---
name: move-to-qa
description: Move an AgentBoard card to the QA column and move its Jira ticket to QA too. With no argument, acts on the card this session belongs to; with a card id, a Jira key (e.g. B2B-4692) or a Jira URL, acts on that card. Use when I type /move-to-qa, or ask to send a card or ticket to QA, mark it ready for QA, or hand it to testing.
---

# Move a card and its Jira ticket to QA

Two moves, one per system: the card goes to the board's `qa` column, and the card's Jira ticket goes to its QA status. The ticket key is what ties them together; the `jira` skill puts it at the front of every card title (`B2B-4692 <short title>`).

## 1. Find the card

```bash
agentboard ls --json
```

- **No argument**: use the card this session belongs to. Its id is in `$AGENTBOARD_TASK_ID`. If that is empty, read `.agentboard/task-id`, starting from the current directory and walking up. If neither exists, you are not in a card's session, so ask me which card.
- **A card id**: the card with that `id`.
- **A Jira key or URL**: pull out every key matching `[A-Z][A-Z0-9]+-\d+`, then find the card whose `title` or `description` contains that key as a whole word (so `B2B-469` does not match `B2B-4692`). If no card has it, say so and stop. Never create a card here. If more than one card has it, list them and ask.

## 2. Find the ticket

Take the Jira key from the card's `title`, and if it is not there, from its `description`. If the card names no key, still move the card (step 3), then tell me it has no Jira ticket. Don't guess a ticket from the card's wording.

If the card names more than one key, transition each of them in step 4.

## 3. Move the card

```bash
agentboard task move <card-id> qa
```

Read what it prints. Don't check the board yourself first. The command and the daemon behind it do that checking.

- `Moved task <id> to QA.`: done.
- `Task <id> is already in QA.`: nothing changed. Say so in the report, and still do step 4, because the ticket may not have moved.
- `Error: Unknown task "<id>"…`: the card is gone or the id is wrong. Stop and tell me; don't move the ticket.
- `Error: Unknown track "qa"…`: this board has no QA column yet, because the daemon is older than the column. The error lists the columns it does have. Stop and tell me to restart the daemon (`npm run reset-daemon` in the AgentBoard repo). Don't pick another column.
- **On a remote card** (`AGENTBOARD_RPC_TOKEN` is set), `agentboard` talks to the Mac board over a forwarded socket. It can move this card or one of its own subtasks, never any other card. `…can only move itself or its own subtasks` means the card isn't yours to move: tell me which card it was, and that it has to be moved from the Mac or from its own session. `Cannot reach the AgentBoard daemon` means the forward is down. Don't retry in a loop; tell me.

Sync never moves a card into or out of `qa`: it stays there while its PR is still open, and after it merges, until someone moves it on (for example `agentboard task move <id> done`). Moving the card does not touch its session or worktree.

If the card move failed, don't move the Jira ticket either. A ticket in QA whose card isn't there is the mismatch this skill exists to prevent.

## 4. Move the ticket

First read the ticket's current status. The transitions list below does not include it:

```
mcp__mcp-s__jira__get-issues
  projectKey: <the key's prefix, e.g. B2B>
  jql: key = B2B-4692
  fields: [key, summary, status]
```

Then:

```
mcp__mcp-s__jira__get-available-transitions
  issueKey: B2B-4692
```

Each transition has its own `name` and a target status in `to.name`. Match on **`to.name`**. Transition names are free text and B2B's are global (every one is offered from every status), so the name says nothing about where the ticket lands.

- Prefer a target status named exactly `QA`, ignoring case. The B2B workflow has both `QA` (transition `61`, as of Oct 2026) and `Ready for QA` (`51`). `QA` is the one to use. Only when there is no exact `QA` should you accept a status whose name has QA as a word, such as `In QA` or `QA Review`.
- **None fits**: don't pick something close, such as "Testing" or "Done". Leave the ticket where it is, list the target statuses it does offer, and ask me.
- **More than one fits, and none is exactly `QA`**: list them and ask me.
- **The ticket is already in that status** (its current `status.name` equals the target's): skip the transition and say it was already there.

```
mcp__mcp-s__jira__transition-issue
  issueKey: B2B-4692
  transitionId: <id from above>
```

Add a `comment` only if I asked for one.

## 5. Report

One line per system, saying what actually happened:

```
Card 3f9a…  "B2B-4692 Fix cart total"  →  QA   (or: already in QA)
Jira B2B-4692  In Review → QA   (https://wix.atlassian.net/browse/B2B-4692)
```

If the Jira call failed, say so plainly, with the error. Don't undo the card move: the card is in QA either way, and I can rerun the Jira half.
