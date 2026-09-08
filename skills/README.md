# AgentBoard skills

Claude Code skills for working with AgentBoard, shared here so the whole team gets the same conventions instead of everyone reinventing them.

## Installing a skill

Skills here are personal, not project-scoped — copy the one you want into your own global Claude Code skills directory:

```bash
cp -r skills/agentboard ~/.claude/skills/
```

Restart Claude Code (or start a new session) to pick it up. It then applies in any repo AgentBoard manages, not just this one.

## Available skills

- **`agentboard`** — everything an agent needs to work with AgentBoard from inside a session: reading the board's state, spinning off follow-up work as a linked subtask card, messaging other cards' sessions, recovering a stuck one, and cleaning up without losing work.
