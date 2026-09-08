// ============================================================
// AgentBoard — the card's brief, parked on disk for the agent
// ============================================================

import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import type { SessionSlot } from '../types/index.js';

/**
 * A brief is whatever the user typed into a card, so it is readable only by
 * them.
 */
export const BRIEF_FILE_MODE = 0o600;

/** Everything AgentBoard parks on a session host lives under this directory. */
const BRIEF_DIRECTORY = 'briefs';

/** `briefs/<task>-<slot>.txt`, joined to whichever host the session runs on. */
export function briefRelativePath(taskId: string, slot: SessionSlot): string {
  return `${BRIEF_DIRECTORY}/${taskId}-${slot}.txt`;
}

/**
 * The resume-time counterpart: messages that arrived while the card had no
 * session, delivered when it next opens.
 *
 * A separate file from the brief because only session-bootstrap.sh knows which
 * of the two applies — it is the thing that decides fresh vs. resume — and the
 * two must never both be used.
 */
export function resumeNoticeRelativePath(taskId: string, slot: SessionSlot): string {
  return `${BRIEF_DIRECTORY}/${taskId}-${slot}-resume.txt`;
}

/** Where a local session — pty or tmux — reads its brief from. */
export function localBriefPath(taskId: string, slot: SessionSlot): string {
  return join(tmpdir(), 'agentboard', briefRelativePath(taskId, slot));
}

/** Where a local session reads its queued messages from. */
export function localResumeNoticePath(taskId: string, slot: SessionSlot): string {
  return join(tmpdir(), 'agentboard', resumeNoticeRelativePath(taskId, slot));
}

/**
 * Park the brief on disk and hand back its path.
 *
 * The bootstrap command is *typed into the session's pane*, and anything past
 * roughly 4 KB of it is dropped on the way in — which leaves the shell sitting
 * on an unterminated quote, waiting forever. A brief is free text with no
 * length ceiling, so it travels as a path rather than as a value, and the
 * command line stays the size it was before briefs existed.
 *
 * Rewritten on every open rather than cleaned up: the card's next session wants
 * the same file, and the board already holds the same text.
 */
export function writeLocalBrief(taskId: string, slot: SessionSlot, prompt: string): string {
  return writeBriefFile(localBriefPath(taskId, slot), prompt);
}

/** {@link writeLocalBrief}, for the queued-message file. */
export function writeLocalResumeNotice(
  taskId: string,
  slot: SessionSlot,
  notice: string,
): string {
  return writeBriefFile(localResumeNoticePath(taskId, slot), notice);
}

function writeBriefFile(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, BRIEF_FILE_MODE);
  return path;
}
