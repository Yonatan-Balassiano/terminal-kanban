import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import {
  composeResumeNotice,
  PendingMessageService,
  type PendingMessage,
} from '../src/services/pending-messages.js';

describe('PendingMessageService', () => {
  let db: Db;
  let board: BoardService;
  let service: PendingMessageService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    service = new PendingMessageService(db);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  it('keeps messages for a card, oldest first', () => {
    // Arrange
    const task = board.createTask({ title: 'Target', repoId: 'repo-1' });

    // Act
    service.enqueue({ taskId: task.id, body: 'first' });
    service.enqueue({ taskId: task.id, body: 'second' });

    // Assert — order is what makes a multi-message recap readable.
    expect(service.list(task.id).map((m) => m.body)).toEqual(['first', 'second']);
  });

  it('keeps each slot queue separate', () => {
    // Arrange — a card can run two sessions; a message for one must not be
    // handed to the other.
    const task = board.createTask({ title: 'Two slots', repoId: 'repo-1' });

    // Act
    service.enqueue({ taskId: task.id, slot: 'primary', body: 'for primary' });
    service.enqueue({ taskId: task.id, slot: 'secondary', body: 'for secondary' });

    // Assert
    expect(service.list(task.id, 'primary').map((m) => m.body)).toEqual(['for primary']);
    expect(service.list(task.id, 'secondary').map((m) => m.body)).toEqual(['for secondary']);
  });

  it('goes with the card when the card is deleted', () => {
    // Arrange — the foreign key cascades, so a deleted card cannot leave
    // messages behind for an id that will never open a session again.
    const task = board.createTask({ title: 'Doomed', repoId: 'repo-1' });
    service.enqueue({ taskId: task.id, body: 'orphan' });

    // Act
    board.deleteTask(task.id);

    // Assert
    expect(service.countByTask().size).toBe(0);
  });

  it('removes only what it is told to', () => {
    // Arrange — a message that arrives *during* session creation must survive
    // the removal of the ones that creation carried.
    const task = board.createTask({ title: 'Racing', repoId: 'repo-1' });
    const carried = service.enqueue({ taskId: task.id, body: 'carried' });
    service.enqueue({ taskId: task.id, body: 'arrived later' });

    // Act
    service.remove([carried.id]);

    // Assert
    expect(service.list(task.id).map((m) => m.body)).toEqual(['arrived later']);
  });
});

describe('composeResumeNotice', () => {
  const base: PendingMessage = {
    id: 'm1',
    taskId: 'task-1',
    slot: 'primary',
    body: 'Address the PR comments on #42.',
    createdAt: 1,
  };

  it('says nothing when there is nothing queued', () => {
    expect(composeResumeNotice([], () => undefined)).toBeUndefined();
  });

  it('names the card a message came from', () => {
    // Arrange + Act
    const notice = composeResumeNotice([{ ...base, fromTaskId: 'parent-1' }], (id) =>
      id === 'parent-1' ? 'Add rate limiting' : undefined,
    );

    // Assert — the agent is being interrupted mid-conversation by something
    // it did not ask for, so who sent it is part of the message.
    expect(notice).toContain('Add rate limiting');
    expect(notice).toContain('Address the PR comments on #42.');
  });

  it('falls back to the id when the sending card is gone', () => {
    // Arrange + Act — the sender may have been deleted since.
    const notice = composeResumeNotice([{ ...base, fromTaskId: 'ghost-1' }], () => undefined);

    // Assert
    expect(notice).toContain('ghost-1');
  });

  it('attributes a message with no sender to the operator', () => {
    // Act
    const notice = composeResumeNotice([base], () => undefined);

    // Assert
    expect(notice).toContain('from your operator');
  });

  it('folds several messages into one turn', () => {
    // Arrange — a resumed session takes a single positional argument, and
    // three separate notices would be three interruptions where one recap
    // reads better.
    const notice = composeResumeNotice(
      [
        { ...base, id: 'm1', body: 'first' },
        { ...base, id: 'm2', body: 'second' },
      ],
      () => undefined,
    );

    // Assert
    expect(notice).toContain('2 messages');
    expect(notice).toContain('first');
    expect(notice).toContain('second');
  });
});
