import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findTranscriptPath,
  forgetTranscriptPath,
  readTranscriptActivity,
  transcriptHasUserMessage,
} from '../src/services/session-transcript.js';

const SESSION_ID = '5f3a1c2e-9b47-4d80-a1f6-2c8e7d4b0913';

describe('session transcript', () => {
  let configDir: string;
  let projectDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'agentboard-transcript-'));
    projectDir = join(configDir, 'projects', '-some-checkout');
    mkdirSync(projectDir, { recursive: true });
    env = { CLAUDE_CONFIG_DIR: configDir };
    forgetTranscriptPath();
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeTranscript(records: unknown[], sessionId = SESSION_ID): string {
    const path = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    return path;
  }

  it('finds a conversation by id without reproducing the directory naming scheme', () => {
    // Arrange — the project directory name encodes a cwd in Claude Code's own
    // format; the session id is a UUID, so it is unambiguous on its own.
    const path = writeTranscript([{ type: 'user', message: { content: 'hi' } }]);

    // Act + Assert
    expect(findTranscriptPath(SESSION_ID, env)).toBe(path);
  });

  it('reports nothing for a session that has not written a conversation yet', () => {
    // Act + Assert — a card opened and not yet spoken to is unknown, not failed.
    expect(readTranscriptActivity(SESSION_ID, env)).toBeNull();
    expect(readTranscriptActivity(undefined, env)).toBeNull();
    expect(transcriptHasUserMessage(SESSION_ID, env)).toBeNull();
  });

  it('confirms the brief arrived when a real user turn exists', () => {
    // Arrange
    writeTranscript([
      { type: 'user', message: { content: 'Fix the flaky test.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
    ]);

    // Act + Assert
    expect(transcriptHasUserMessage(SESSION_ID, env)).toBe(true);
  });

  it('does not count a tool result as the brief arriving', () => {
    // Arrange — Claude Code writes tool results back as `type: "user"` records.
    // Counting those would report a delivered brief for any session that had
    // run a single tool, including one started with no brief at all.
    writeTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    ]);

    // Act + Assert
    expect(transcriptHasUserMessage(SESSION_ID, env)).toBe(false);
  });

  it('reads the mtime as the agent heartbeat', () => {
    // Arrange
    const path = writeTranscript([{ type: 'user', message: { content: 'hi' } }]);
    const when = new Date('2026-09-08T10:00:00Z');
    utimesSync(path, when, when);

    // Act
    const activity = readTranscriptActivity(SESSION_ID, env);

    // Assert — this is the signal that replaces "did the terminal change",
    // and it needs no parsing, so a transcript format change cannot break it.
    expect(activity?.lastActivityAt).toBe(when.getTime());
  });

  it('survives record types and shapes it does not recognise', () => {
    // Arrange — a live transcript carries Claude Code's own internal records
    // (queue-operation, attachment, last-prompt, ...) and its final line may be
    // half-written. None of that should cost us the answer.
    const path = join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'queue-operation', payload: 1 }),
        JSON.stringify({ type: 'attachment' }),
        'not json at all',
        JSON.stringify({ type: 'user', message: { content: 'Fix the flaky test.' } }),
        '{"type":"assistant","message":{"cont',
      ].join('\n'),
    );

    // Act + Assert
    expect(transcriptHasUserMessage(SESSION_ID, env)).toBe(true);
    expect(readTranscriptActivity(SESSION_ID, env)?.lastActivityAt).toBeGreaterThan(0);
  });

  it('does not read a whole multi-megabyte conversation to answer', () => {
    // Arrange — transcripts reach megabytes (3.2 MB seen on a real machine)
    // and this runs on the board's polling loop, so only a bounded prefix is
    // read. The brief is the first turn, so that is where the answer is.
    const filler = { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(200) }] } };
    writeTranscript([
      { type: 'user', message: { content: 'Fix the flaky test.' } },
      ...Array.from({ length: 5000 }, () => filler),
    ]);

    // Act
    const started = process.hrtime.bigint();
    const answer = transcriptHasUserMessage(SESSION_ID, env);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Assert
    expect(answer).toBe(true);
    expect(elapsedMs).toBeLessThan(50);
  });

  it('answers for the prefix it read, when no user turn is in it', () => {
    // Arrange — over 256 KB of assistant traffic and no human turn inside it.
    const filler = { type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(500) }] } };
    writeTranscript(Array.from({ length: 800 }, () => filler));

    // Act + Assert — `false` means "scanned, not found", which callers treat
    // as not-yet-confirmed and fall back to the stored flag for, rather than
    // reporting an unsubmitted brief.
    expect(transcriptHasUserMessage(SESSION_ID, env)).toBe(false);
  });
});
