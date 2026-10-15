import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findTranscriptPath,
  forgetTranscriptPath,
  readTranscriptActivity,
  readTranscriptTail,
  resolveContinuedSessionId,
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

  describe('readTranscriptTail', () => {
    it('keeps what a person reads and drops the plumbing', () => {
      writeTranscript([
        { type: 'user', message: { content: 'Fix the flaky test.' }, timestamp: '2026-10-15T08:00:00Z' },
        { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\nmore' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'big output' }] } },
        { type: 'user', isMeta: true, message: { content: 'caveat' } },
        { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
        { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
        { type: 'last-prompt', lastPrompt: 'x' },
        { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it.' }] } },
      ]);

      const tail = readTranscriptTail(SESSION_ID, 30, env);

      expect(tail?.messages).toEqual([
        { role: 'user', text: 'Fix the flaky test.', at: Date.parse('2026-10-15T08:00:00Z') },
        { role: 'tool', text: 'Bash: npm test', at: undefined },
        { role: 'tool', text: 'Conversation compacted — earlier turns summarized', at: undefined },
        { role: 'assistant', text: 'Fixed it.', at: undefined },
      ]);
      expect(tail?.updatedAt).toBeGreaterThan(0);
    });

    it('returns only the last messages, and skips a record cut by the read window', () => {
      const records = Array.from({ length: 50 }, (_, i) => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `turn ${i}` }] },
      }));
      writeTranscript(records);
      expect(readTranscriptTail(SESSION_ID, 3, env)?.messages.map((m) => m.text)).toEqual([
        'turn 47',
        'turn 48',
        'turn 49',
      ]);

      // Bigger than the read window: the cut first line must not break parsing.
      writeTranscript([
        { type: 'user', message: { content: 'x'.repeat(900 * 1024) } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'still here' }] } },
      ]);
      forgetTranscriptPath();
      expect(readTranscriptTail(SESSION_ID, 30, env)?.messages.map((m) => m.text)).toEqual(['still here']);
    });

    it('is null when there is no conversation', () => {
      expect(readTranscriptTail(SESSION_ID, 30, env)).toBeNull();
      expect(readTranscriptTail(undefined, 30, env)).toBeNull();
    });
  });

  describe('resolveContinuedSessionId', () => {
    const FORK_ID = '0c7e2b19-4d3a-4f6e-9b81-6a2d5c4e8f07';
    const SECOND_FORK_ID = '7a1d9e40-2b6c-4e8f-a3d5-1f0b8c6e2d94';

    function age(path: string, secondsAgo: number): void {
      const at = new Date(Date.now() - secondsAgo * 1000);
      utimesSync(path, at, at);
    }

    it('follows the pointer Claude Code leaves when it reopens a conversation as a fork', () => {
      // Arrange — the original stops where the fork began; the fork carries on.
      const original = writeTranscript([
        { type: 'user', message: { content: 'Fix the flaky test.' } },
        { type: 'continued-in', sessionId: SESSION_ID, continuedInSessionId: FORK_ID },
      ]);
      writeTranscript([{ type: 'user', message: { content: 'fix conflicts' } }], FORK_ID);
      age(original, 60);

      // Act + Assert
      expect(resolveContinuedSessionId(SESSION_ID, env)).toBe(FORK_ID);
    });

    it('follows a chain of forks to the newest', () => {
      // Arrange
      const original = writeTranscript([
        { type: 'continued-in', sessionId: SESSION_ID, continuedInSessionId: FORK_ID },
      ]);
      const fork = writeTranscript(
        [{ type: 'continued-in', sessionId: FORK_ID, continuedInSessionId: SECOND_FORK_ID }],
        FORK_ID,
      );
      writeTranscript([{ type: 'user', message: { content: 'hi' } }], SECOND_FORK_ID);
      age(original, 120);
      age(fork, 60);

      // Act + Assert
      expect(resolveContinuedSessionId(SESSION_ID, env)).toBe(SECOND_FORK_ID);
    });

    it('keeps the original when it was resumed and worked in after the fork', () => {
      // Arrange — the fork is older than the original's latest turn, so the
      // original is the conversation someone chose to continue.
      writeTranscript([
        { type: 'continued-in', sessionId: SESSION_ID, continuedInSessionId: FORK_ID },
        { type: 'user', message: { content: 'what is next?' } },
      ]);
      const fork = writeTranscript([{ type: 'user', message: { content: 'hi' } }], FORK_ID);
      age(fork, 60);

      // Act + Assert
      expect(resolveContinuedSessionId(SESSION_ID, env)).toBe(SESSION_ID);
    });

    it('keeps the id when there is no fork, no transcript, or the fork is missing', () => {
      // Act + Assert — never forked, nothing on disk yet.
      expect(resolveContinuedSessionId(SESSION_ID, env)).toBe(SESSION_ID);
      writeTranscript([{ type: 'user', message: { content: 'hi' } }]);
      expect(resolveContinuedSessionId(SESSION_ID, env)).toBe(SESSION_ID);

      // A pointer to a conversation that is not on this machine.
      writeTranscript([
        { type: 'continued-in', sessionId: SESSION_ID, continuedInSessionId: FORK_ID },
      ]);
      expect(resolveContinuedSessionId(SESSION_ID, env)).toBe(SESSION_ID);
    });

    it('stops on a cycle instead of looping', () => {
      // Arrange
      writeTranscript([
        { type: 'continued-in', sessionId: SESSION_ID, continuedInSessionId: FORK_ID },
      ]);
      writeTranscript(
        [{ type: 'continued-in', sessionId: FORK_ID, continuedInSessionId: SESSION_ID }],
        FORK_ID,
      );

      // Act + Assert — either end is acceptable; terminating is the point.
      expect([SESSION_ID, FORK_ID]).toContain(resolveContinuedSessionId(SESSION_ID, env));
    });
  });
});
