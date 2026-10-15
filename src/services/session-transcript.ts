// ============================================================
// AgentBoard — read a session's own transcript as ground truth
// ============================================================

import { closeSync, globSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * What a card's conversation file says about its session.
 *
 * AgentBoard already pins every session's conversation id (`--session-id`, see
 * session-bootstrap.sh), so it knows exactly which file on disk belongs to
 * which card — and until now never looked at it. That file is the conversation
 * itself, which makes it the one place two questions can be answered exactly
 * rather than inferred from what a terminal happens to be rendering:
 *
 *   - is the agent doing anything right now (the file is still being written), and
 *   - was the opening brief actually received (a user message exists).
 *
 * Deliberately a *best-effort, read-only* signal. The JSONL layout is Claude
 * Code's own and may change between releases, so every field here is optional
 * and callers keep their existing fallbacks. Note that `lastActivityAt` comes
 * from the file's mtime and needs no parsing at all, so the more load-bearing
 * of the two answers is also the one that cannot break on a format change.
 */
export interface TranscriptActivity {
  /** The resolved conversation file. */
  path: string;
  /** When it was last written — the agent's own heartbeat. */
  lastActivityAt: number;
}

/** Where Claude Code keeps its conversations. Honours the same override session-bootstrap.sh reads. */
function claudeProjectsDir(env: NodeJS.ProcessEnv): string {
  return join(env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'projects');
}

/**
 * Resolved conversation paths, keyed by session id.
 *
 * The glob behind {@link findTranscriptPath} walks every project directory
 * Claude Code has ever created — several hundred on a machine that has been
 * used for a while — and both callers here run on the board's polling loop,
 * once per live session. A conversation never moves once written, so resolving
 * it once per session id is safe and takes that walk off the poll entirely.
 *
 * Misses are not cached: a session that has not written its first turn yet has
 * no file to find, and will have one shortly.
 */
const pathCache = new Map<string, string>();

/**
 * Finds a conversation file by its id, without reproducing Claude Code's own
 * directory-naming scheme.
 *
 * The id is a UUID, so a glob across every project directory is unambiguous —
 * and it stays correct if the encoding of a cwd into a directory name ever
 * changes, which a reimplementation of that encoding would not.
 */
export function findTranscriptPath(
  agentSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!agentSessionId) {
    return null;
  }
  const cached = pathCache.get(agentSessionId);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const match = globSync(join(claudeProjectsDir(env), '*', `${agentSessionId}.jsonl`))[0];
    if (match === undefined) {
      return null;
    }
    pathCache.set(agentSessionId, match);
    return match;
  } catch {
    return null;
  }
}

/** Drops a session's cached path. For tests, and for a deleted conversation. */
export function forgetTranscriptPath(agentSessionId?: string): void {
  if (agentSessionId === undefined) {
    pathCache.clear();
    return;
  }
  pathCache.delete(agentSessionId);
}

/**
 * When this session's agent last wrote to its conversation.
 *
 * The whole answer is one `stat`, which is what makes this safe to call on
 * every board poll for every live session — and means it cannot break on a
 * transcript format change, because it reads no content at all.
 */
export function readTranscriptActivity(
  agentSessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): TranscriptActivity | null {
  if (!agentSessionId) {
    return null;
  }
  const path = findTranscriptPath(agentSessionId, env);
  if (!path) {
    return null;
  }
  try {
    return { path, lastActivityAt: statSync(path).mtimeMs };
  } catch {
    // The conversation was removed out from under us; re-resolve next time.
    forgetTranscriptPath(agentSessionId);
    return null;
  }
}

/**
 * How much of a conversation to read looking for its first user turn.
 *
 * The turn being looked for is the card's own opening brief, so it is the
 * first thing in the file — but a transcript grows to megabytes (3.2 MB
 * observed on this machine), and reading one whole on every poll would be a
 * real cost for an answer that is always in its first few KB. Beyond this
 * prefix the answer is reported as unknown rather than paid for.
 */
const USER_MESSAGE_SCAN_BYTES = 256 * 1024;

/**
 * Whether a record is a genuine user turn rather than a tool result.
 *
 * Claude Code writes tool results back as `type: "user"` records whose content
 * is a list of `tool_result` blocks. Counting those as "the brief arrived"
 * would report success for any session that had run a single tool, including
 * one that was started with no brief at all.
 */
function isRealUserMessage(record: unknown): boolean {
  if (typeof record !== 'object' || record === null) {
    return false;
  }
  const entry = record as { type?: unknown; message?: { content?: unknown } };
  if (entry.type !== 'user') {
    return false;
  }
  const content = entry.message?.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type !== 'tool_result',
  );
}

/** Reads at most `USER_MESSAGE_SCAN_BYTES` from the front of a file. */
function readPrefix(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(USER_MESSAGE_SCAN_BYTES);
    const bytes = readSync(fd, buffer, 0, USER_MESSAGE_SCAN_BYTES, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do about a failed close.
      }
    }
  }
}

/**
 * Whether this session's agent has actually received a message from a person.
 *
 * The honest answer to "did the card's brief land", read from the conversation
 * rather than inferred from whether a paste appeared to render on a terminal.
 * Null means unknown — no conversation written yet, unreadable, or no user
 * turn inside the scanned prefix — which callers must not report as a failure.
 */
export function transcriptHasUserMessage(
  agentSessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean | null {
  if (!agentSessionId) {
    return null;
  }
  const path = findTranscriptPath(agentSessionId, env);
  if (!path) {
    return null;
  }
  const prefix = readPrefix(path);
  if (prefix === null) {
    return null;
  }

  const lines = prefix.split('\n');
  // A prefix cut mid-line leaves a partial final entry; a complete file leaves
  // an empty one. Either way the last element is not a record to trust.
  lines.pop();
  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    try {
      if (isRealUserMessage(JSON.parse(line))) {
        return true;
      }
    } catch {
      // Claude Code writes record types of its own that this does not model.
    }
  }
  return false;
}

/** The record Claude Code appends to a conversation when it forks it. */
const CONTINUED_IN_MARKER = '"type":"continued-in"';

/** How many forks to follow before giving up — a guard, not an expected depth. */
const MAX_CONTINUATION_HOPS = 16;

/**
 * The id a conversation's latest fork continued under, read from the
 * `continued-in` record Claude Code writes into the original when it reopens
 * it as a fork. Null when it was never forked or the file is unreadable.
 */
function readContinuedIn(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const at = text.lastIndexOf(CONTINUED_IN_MARKER);
  if (at === -1) {
    return null;
  }
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  try {
    const record = JSON.parse(text.slice(start, end === -1 ? undefined : end)) as {
      continuedInSessionId?: unknown;
    };
    return typeof record.continuedInSessionId === 'string' && record.continuedInSessionId
      ? record.continuedInSessionId
      : null;
  } catch {
    return null;
  }
}

/**
 * The conversation a card should resume, following Claude Code's own forks.
 *
 * Claude Code can reopen a conversation under a new id — observed when it
 * relaunched itself in a live pane after an update — leaving only a
 * `continued-in` pointer behind in the original. Everything said after that
 * goes to the fork, so resuming the id AgentBoard pinned at creation brings
 * back a conversation that stops where the fork began.
 *
 * A pointer is followed only when the fork was written at least as recently
 * as the conversation it left: if the original has been resumed and worked in
 * since, it is the newer of the two and is kept. Returns the given id
 * unchanged whenever anything is missing or unreadable.
 */
export function resolveContinuedSessionId(
  agentSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let current = agentSessionId;
  const seen = new Set([current]);
  for (let hop = 0; hop < MAX_CONTINUATION_HOPS; hop++) {
    const path = findTranscriptPath(current, env);
    if (!path) {
      return current;
    }
    const next = readContinuedIn(path);
    if (!next || seen.has(next)) {
      return current;
    }
    const nextPath = findTranscriptPath(next, env);
    if (!nextPath) {
      return current;
    }
    try {
      if (statSync(nextPath).mtimeMs < statSync(path).mtimeMs) {
        return current;
      }
    } catch {
      return current;
    }
    seen.add(next);
    current = next;
  }
  return current;
}
