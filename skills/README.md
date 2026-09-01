# AgentBoard skills

Claude Code skills for working with AgentBoard, shared here so the whole team gets the same conventions instead of everyone reinventing them.

## Installing a skill

Skills here are personal, not project-scoped — copy the one you want into your own global Claude Code skills directory:

```bash
cp -r skills/spawn-subtask ~/.claude/skills/
```

Restart Claude Code (or start a new session) to pick it up. It then applies in any repo AgentBoard manages, not just this one.

## Available skills

- **`spawn-subtask`** — spinning off follow-up work as its own AgentBoard card: linking it back to the task that spawned it, naming its session so it's addressable via Claude Code's own `SendMessage`/`ListAgents`, and the notify loop for PR review back-and-forth between a card and its subtasks.
