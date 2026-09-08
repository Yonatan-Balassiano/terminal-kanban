// ============================================================
// AgentBoard — messages waiting for a card's session to open
// ============================================================

import { generateId, type Db } from '../db/index.js';
import type { SessionSlot } from '../types/index.js';

export interface PendingMessage {
  id: string;
  taskId: string;
  slot: SessionSlot;
  body: string;
  /** The card that sent it, when a card sent it; undefined for a person. */
  fromTaskId?: string;
  createdAt: number;
}

interface PendingMessageRow {
  id: string;
  task_id: string;
  slot: SessionSlot;
  body: string;
  from_task_id: string | null;
  created_at: number;
}

function rowToMessage(row: PendingMessageRow): PendingMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    slot: row.slot,
    body: row.body,
    fromTaskId: row.from_task_id ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Holds cross-task messages sent to a card whose session was not running.
 *
 * `agentboard task notify` delivers by typing into a live pane. With no pane
 * there was nothing to type into, so the message was dropped and reported as
 * undelivered — which is why the board grew a badge to stand in for it. A
 * badge tells you an event happened; it cannot tell the agent what was said.
 *
 * Queued here instead, the message is handed to the agent as part of its own
 * argv the next time its session opens (see `composeResumeNotice` and
 * session-bootstrap.sh), landing in the conversation exactly as a live one
 * would. The badge stops being the record and becomes a hint that something
 * is waiting.
 */
export class PendingMessageService {
  constructor(private db: Db) {}

  /** Queues a message for a card. Returns the stored row. */
  enqueue(params: {
    taskId: string;
    slot?: SessionSlot;
    body: string;
    fromTaskId?: string;
  }): PendingMessage {
    const message: PendingMessage = {
      id: generateId(),
      taskId: params.taskId,
      slot: params.slot ?? 'primary',
      body: params.body,
      fromTaskId: params.fromTaskId,
      createdAt: Date.now(),
    };

    this.db
      .prepare<[string, string, SessionSlot, string, string | null, number], void>(
        `INSERT INTO pending_messages (id, task_id, slot, body, from_task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.taskId,
        message.slot,
        message.body,
        message.fromTaskId ?? null,
        message.createdAt,
      );

    return message;
  }

  /** Everything waiting for this card's session, oldest first. */
  list(taskId: string, slot: SessionSlot = 'primary'): PendingMessage[] {
    return this.db
      .prepare<[string, SessionSlot], PendingMessageRow>(
        `SELECT * FROM pending_messages
          WHERE task_id = ? AND slot = ?
          ORDER BY created_at ASC`,
      )
      .all(taskId, slot)
      .map(rowToMessage);
  }

  /**
   * Drops the given messages.
   *
   * Called only once the session that will carry them has actually been
   * created — not when the prompt file is written. A session that fails to
   * spawn must leave its messages queued, or this would reintroduce the very
   * loss it exists to prevent, just in a narrower window.
   */
  remove(ids: readonly string[]): void {
    if (ids.length === 0) {
      return;
    }
    const statement = this.db.prepare<[string], void>('DELETE FROM pending_messages WHERE id = ?');
    this.db.transaction(() => {
      for (const id of ids) {
        statement.run(id);
      }
    })();
  }

  /** How many cards have something waiting, for the board's own summary. */
  countByTask(): Map<string, number> {
    const rows = this.db
      .prepare<[], { task_id: string; count: number }>(
        'SELECT task_id, COUNT(*) AS count FROM pending_messages GROUP BY task_id',
      )
      .all();
    return new Map(rows.map((row) => [row.task_id, row.count]));
  }
}

/**
 * Renders queued messages as the prompt a reopened session starts on.
 *
 * Joined into one turn rather than delivered as several: a resumed session
 * takes a single positional argument, and three separate notices would in any
 * case be three interruptions where one recap reads better.
 *
 * Prefixed so the agent can tell this apart from something its human typed —
 * it arrives unprompted, in the middle of a conversation that may be hours
 * old, and the sender is usually another card rather than a person.
 */
export function composeResumeNotice(
  messages: readonly PendingMessage[],
  senderTitle: (taskId: string) => string | undefined,
): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }

  const rendered = messages.map((message) => {
    const from = message.fromTaskId ? senderTitle(message.fromTaskId) : undefined;
    const attribution = from ? `from "${from}"` : message.fromTaskId ? `from task ${message.fromTaskId}` : 'from your operator';
    return `- (${attribution}) ${message.body}`;
  });

  const preamble =
    messages.length === 1
      ? '[agentboard] A message arrived while this session was closed:'
      : `[agentboard] ${String(messages.length)} messages arrived while this session was closed:`;

  return `${preamble}\n${rendered.join('\n')}`;
}
