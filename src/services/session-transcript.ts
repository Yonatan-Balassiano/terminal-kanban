// ============================================================
// AgentBoard — read a session's own transcript as ground truth
// ============================================================

import { closeSync, globSync, openSync, readSync, statSync } from 'fs';
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

/** One turn of a conversation, reduced to what a person reads. */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** Epoch ms, when the record carries a timestamp. */
  at?: number;
}

/**
 * How much of a conversation's end to read for its preview. Transcripts reach
 * tens of MB; the last few turns are always in the tail, and one long tool
 * result can fill this on its own, which is why the preview may show fewer
 * messages than asked for rather than reading further.
 */
const TAIL_SCAN_BYTES = 768 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOOL_CHARS = 160;

function readSuffix(path: string, bytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.allocUnsafe(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, read).toString('utf8');
    // A suffix cut mid-line starts with a partial record.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
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

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Claude Code's own bookkeeping turns (slash commands, their output), not something a person said. */
function isCommandNoise(text: string): boolean {
  return /^<(command-|local-command-|system-reminder)/.test(text.trimStart());
}

function toolSummary(block: { name?: unknown; input?: unknown }): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<
    string,
    unknown
  >;
  const detail = ['description', 'command', 'file_path', 'pattern', 'url', 'prompt']
    .map((key) => input[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return clip(detail ? `${name}: ${detail.split('\n')[0]}` : name, MAX_TOOL_CHARS);
}

function recordMessages(record: unknown): ConversationMessage[] {
  if (typeof record !== 'object' || record === null) {
    return [];
  }
  const entry = record as {
    type?: unknown;
    isMeta?: unknown;
    isSidechain?: unknown;
    isCompactSummary?: unknown;
    timestamp?: unknown;
    message?: { content?: unknown };
  };
  if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true || entry.isSidechain === true) {
    return [];
  }
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) || undefined : undefined;
  if (entry.isCompactSummary === true) {
    // Claude Code's own summary of the earlier conversation: a marker, not something the user said.
    return [{ role: 'tool', text: 'Conversation compacted — earlier turns summarized', at }];
  }
  const content = entry.message?.content;
  const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const out: ConversationMessage[] = [];
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() && !isCommandNoise(block.text)) {
      out.push({ role: entry.type, text: clip(block.text, MAX_MESSAGE_CHARS), at });
    } else if (block.type === 'tool_use' && entry.type === 'assistant') {
      out.push({ role: 'tool', text: toolSummary(block), at });
    }
    // tool_result, thinking and images are left out: the preview is the conversation, not its plumbing.
  }
  return out;
}

/**
 * The last `limit` readable turns of a session's conversation, oldest first.
 * Null means there is no conversation to read (none written yet, or not on
 * this machine). Best-effort like everything here: records it does not model
 * are skipped.
 */
export function readTranscriptTail(
  agentSessionId: string | undefined,
  limit = 30,
  env: NodeJS.ProcessEnv = process.env,
): { messages: ConversationMessage[]; updatedAt: number } | null {
  if (!agentSessionId) {
    return null;
  }
  const path = findTranscriptPath(agentSessionId, env);
  if (!path) {
    return null;
  }
  const suffix = readSuffix(path, TAIL_SCAN_BYTES);
  if (suffix === null) {
    forgetTranscriptPath(agentSessionId);
    return null;
  }
  const messages: ConversationMessage[] = [];
  for (const line of suffix.split('\n')) {
    if (!line) continue;
    try {
      messages.push(...recordMessages(JSON.parse(line)));
    } catch {
      // A record still being written, or one this does not model.
    }
  }
  let updatedAt = 0;
  try {
    updatedAt = statSync(path).mtimeMs;
  } catch {
    // Keep 0; the messages are still worth showing.
  }
  return { messages: messages.slice(-limit), updatedAt };
}
