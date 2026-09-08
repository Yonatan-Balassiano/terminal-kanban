// ============================================================
// AgentBoard — messages waiting for a card's session to open
// ============================================================

import { existsSync, rmSync } from 'fs';
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
  claimed_session_id: string | null;
  claimed_at: number | null;
  claim_notice_path: string | null;
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
   * Hands the given messages to a session that is about to carry them,
   * without dropping them yet.
   *
   * Deleting at this point is what issue #46 §2 was: `create()` resolves once
   * the bootstrap command has been *typed into the pane*, before the script
   * has run, let alone read the file. A pane that dies in between took the
   * message with it and nothing anywhere recorded that it had existed.
   *
   * `receiptPath` is the file session-bootstrap.sh creates once it has folded
   * the messages into the agent's own argv, and it is the only proof that the
   * hand-off happened — see {@link reconcileClaims}.
   *
   * A receipt rather than "the notice file is gone": the script deletes the
   * notice on every path it takes, and a backend that found the session
   * already running writes no notice at all, so absence proves nothing. The
   * receipt is written on exactly one path.
   *
   * A `create()` that never wrote a notice therefore leaves no receipt, and
   * the messages are simply re-delivered on the next open — the safe
   * direction, and the one the old code got wrong.
   */
  claim(ids: readonly string[], claim: { sessionId?: string; receiptPath: string }): void {
    if (ids.length === 0) {
      return;
    }
    // The receipt path is derived from the card, so it is the same file every
    // time this card opens. Clear it first: a leftover from an earlier open —
    // one whose rows were removed some other way, a card deleted mid-flight —
    // would otherwise read as instant proof that *this* hand-off happened, and
    // these messages would be dropped without ever being delivered.
    rmSync(claim.receiptPath, { force: true });
    const statement = this.db.prepare<[string | null, number, string, string], void>(
      `UPDATE pending_messages
          SET claimed_session_id = ?, claimed_at = ?, claim_notice_path = ?
        WHERE id = ?`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const id of ids) {
        statement.run(claim.sessionId ?? null, now, claim.receiptPath, id);
      }
    })();
  }

  /**
   * Settles every outstanding claim for a card, and returns what is left to
   * deliver.
   *
   * A claimed row whose receipt exists was folded into the agent's own argv by
   * session-bootstrap.sh, so the message reached the conversation and the row
   * can go. The receipt is consumed along with it.
   *
   * A claimed row with no receipt was never handed over. Its claim is cleared
   * so the next open delivers it, which is the whole point: a pane that died
   * before reading its messages no longer takes them with it.
   *
   * With no `taskId`, settles every card's claims — what the board's own
   * counter needs, since it reports on cards nobody is opening.
   */
  reconcileClaims(taskId?: string, slot: SessionSlot = 'primary'): void {
    const claimed =
      taskId === undefined
        ? this.db
            .prepare<[], PendingMessageRow>(
              'SELECT * FROM pending_messages WHERE claimed_at IS NOT NULL',
            )
            .all()
        : this.db
            .prepare<[string, SessionSlot], PendingMessageRow>(
              `SELECT * FROM pending_messages
                WHERE task_id = ? AND slot = ? AND claimed_at IS NOT NULL`,
            )
            .all(taskId, slot);

    const wasRead = (row: PendingMessageRow): boolean =>
      row.claim_notice_path !== null && existsSync(row.claim_notice_path);
    const consumed = claimed.filter(wasRead);
    const stranded = claimed.filter((row) => !wasRead(row)).map((row) => row.id);

    for (const receipt of new Set(consumed.map((row) => row.claim_notice_path))) {
      if (receipt) {
        rmSync(receipt, { force: true });
      }
    }
    this.remove(consumed.map((row) => row.id));
    if (stranded.length > 0) {
      const statement = this.db.prepare<[string], void>(
        `UPDATE pending_messages
            SET claimed_session_id = NULL, claimed_at = NULL, claim_notice_path = NULL
          WHERE id = ?`,
      );
      this.db.transaction(() => {
        for (const id of stranded) {
          statement.run(id);
        }
      })();
    }
  }

  /** Drops the given messages outright. */
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

  /**
   * How many cards have something waiting, for the board's own summary.
   *
   * Reconciles first, across every card: a claimed row that was in fact
   * consumed is not waiting for anything, and left alone it would inflate the
   * badge of a card that never reopens.
   */
  countByTask(): Map<string, number> {
    this.reconcileClaims();
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
