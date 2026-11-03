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

/** A page a session published with Claude Code's Artifact tool. */
export interface TranscriptArtifact {
  /** The page's claude.ai link — the same link for every version. */
  url: string;
  title?: string;
  icon?: string;
  /** The one-line description passed on publish, when there was one. */
  description?: string;
  /** Its latest version number seen (1 when published once). */
  versions: number;
  /** Epoch ms of the first and latest publish seen. */
  firstPublishedAt?: number;
  lastPublishedAt?: number;
}

/**
 * What one conversation file has yielded so far. A transcript only ever grows,
 * so a scan picks up from `offset` instead of re-reading tens of MB on every
 * poll; a file that shrank was replaced and is read again from the start.
 */
interface ArtifactScan {
  offset: number;
  artifacts: Map<string, TranscriptArtifact>;
  /** Publish inputs not yet matched to a result, by tool_use id. */
  pending: Map<string, Record<string, unknown>>;
  /** Forks this conversation continued in (`continued-in` records). */
  continuedIn: Set<string>;
}

const artifactScans = new Map<string, ArtifactScan>();
const ARTIFACT_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function scanArtifactLine(line: string, scan: ArtifactScan): void {
  // Cheap filters first: almost no line in a transcript is one of these.
  const isUse = line.includes('"name":"Artifact"') && line.includes('"type":"tool_use"');
  const isResult = line.includes('"artifact_id"');
  const isFork = line.includes(CONTINUED_IN_MARKER);
  if (!isUse && !isResult && !isFork) return;
  let record: {
    timestamp?: unknown;
    message?: { content?: unknown };
    toolUseResult?: unknown;
    continuedInSessionId?: unknown;
  };
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof record?.continuedInSessionId === 'string' && record.continuedInSessionId) {
    scan.continuedIn.add(record.continuedInSessionId);
  }
  const content = Array.isArray(record?.message?.content) ? (record.message.content as unknown[]) : [];
  let useId: string | undefined;
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown };
    if (block.type === 'tool_use' && block.name === 'Artifact' && typeof block.id === 'string') {
      if (typeof block.input === 'object' && block.input !== null) {
        scan.pending.set(block.id, block.input as Record<string, unknown>);
      }
    } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      useId = block.tool_use_id;
    }
  }
  // Only a publish's structured result carries both the link and the artifact's id;
  // reads, listings and asset uploads do not, and Claude Code repeats some
  // results in records with no structured result at all.
  const result = record?.toolUseResult;
  if (typeof result !== 'object' || result === null) return;
  const fields = result as Record<string, unknown>;
  const url = stringField(fields, 'url');
  if (!url || !stringField(fields, 'artifact_id') || !/^https:\/\/claude\.ai\//.test(url)) return;
  const input = useId ? scan.pending.get(useId) : undefined;
  if (useId) scan.pending.delete(useId);
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) || undefined : undefined;
  const existing = scan.artifacts.get(url);
  // The artifact's own version number, not a count of publishes seen: a fork
  // or a subagent's file can repeat a publish the main file already holds.
  const seq = typeof fields['seq'] === 'number' ? fields['seq'] : (existing?.versions ?? 0) + 1;
  scan.artifacts.set(url, {
    url,
    title: stringField(fields, 'title') ?? existing?.title,
    icon: stringField(fields, 'icon') ?? existing?.icon,
    description: (input && stringField(input, 'description')) ?? existing?.description,
    versions: Math.max(seq, existing?.versions ?? 0),
    firstPublishedAt: existing?.firstPublishedAt ?? at,
    lastPublishedAt: at ?? existing?.lastPublishedAt,
  });
}

/** Brings one file's scan up to date, reading only what was appended since the last call. */
function scanArtifactFile(path: string): ArtifactScan | null {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    let scan = artifactScans.get(path);
    if (!scan || size < scan.offset) {
      scan = { offset: 0, artifacts: new Map(), pending: new Map(), continuedIn: new Set() };
      artifactScans.set(path, scan);
    }
    if (size === scan.offset) return scan;
    fd = openSync(path, 'r');
    let carry = '';
    let position = scan.offset;
    while (position < size) {
      const buffer = Buffer.allocUnsafe(Math.min(ARTIFACT_SCAN_CHUNK_BYTES, size - position));
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      position += read;
      const text = carry + buffer.subarray(0, read).toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        carry = text;
        continue;
      }
      for (const line of text.slice(0, lastNewline).split('\n')) {
        if (line) scanArtifactLine(line, scan);
      }
      carry = text.slice(lastNewline + 1);
    }
    // A record still being written stays unread until its newline lands.
    scan.offset = position - Buffer.byteLength(carry, 'utf8');
    return scan;
  } catch {
    artifactScans.delete(path);
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
 * Every page these conversations published with the Artifact tool, newest
 * first, one entry per link however many times it was republished. Covers
 * each conversation's own subagents (`<id>/subagents/*.jsonl`) and any fork
 * Claude Code continued it in — unlike resuming, nothing published in an
 * older part of the conversation should drop off the list.
 */
export function readTranscriptArtifacts(
  agentSessionIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): TranscriptArtifact[] {
  const merged = new Map<string, TranscriptArtifact>();
  const queue = [...agentSessionIds];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < agentSessionIds.length + MAX_CONTINUATION_HOPS) {
    const id = queue.shift()!;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const path = findTranscriptPath(id, env);
    if (!path) continue;
    let files = [path];
    try {
      files = files.concat(globSync(join(path.slice(0, -'.jsonl'.length), 'subagents', '*.jsonl')));
    } catch {
      // No subagents directory is the usual case.
    }
    for (const file of files) {
      const scan = scanArtifactFile(file);
      if (!scan) continue;
      scan.continuedIn.forEach((next) => queue.push(next));
      for (const artifact of scan.artifacts.values()) {
        const existing = merged.get(artifact.url);
        merged.set(artifact.url, existing ? mergeArtifacts(existing, artifact) : { ...artifact });
      }
    }
  }
  return [...merged.values()].sort((a, b) => (b.lastPublishedAt ?? 0) - (a.lastPublishedAt ?? 0));
}

function mergeArtifacts(a: TranscriptArtifact, b: TranscriptArtifact): TranscriptArtifact {
  const [older, newer] = (a.lastPublishedAt ?? 0) <= (b.lastPublishedAt ?? 0) ? [a, b] : [b, a];
  const firsts = [a.firstPublishedAt, b.firstPublishedAt].filter((at): at is number => at !== undefined);
  return {
    url: a.url,
    title: newer.title ?? older.title,
    icon: newer.icon ?? older.icon,
    description: newer.description ?? older.description,
    versions: Math.max(a.versions, b.versions),
    firstPublishedAt: firsts.length > 0 ? Math.min(...firsts) : undefined,
    lastPublishedAt: newer.lastPublishedAt ?? older.lastPublishedAt,
  };
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
