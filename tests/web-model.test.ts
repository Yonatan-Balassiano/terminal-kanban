import { describe, expect, it } from 'vitest';
import {
  buildCardTree,
  cardState,
  prStage,
  type BoardSnapshot,
  type FleetSessionStatus,
  type PRReleaseStatus,
  type TaskBranchRecord,
  type TaskRecord,
} from '../web/src/model.js';

function branch(patch: Partial<TaskBranchRecord> = {}): TaskBranchRecord {
  return {
    id: 'b1',
    taskId: 't1',
    repoId: 'r1',
    branchName: 'ab/t1',
    sortKey: 0,
    prNumber: 10,
    prState: 'open',
    prDraft: false,
    ciState: 'passed',
    ciRequiredTotal: 1,
    ciRequiredPassed: 1,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    reviewState: 'none',
    unresolvedThreadCount: 0,
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    githubSyncStatus: 'ok',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as TaskBranchRecord;
}

function task(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: id,
    kind: 'repo',
    repoId: 'r1',
    agentCli: 'claude',
    location: 'local',
    trackId: 'in-progress',
    labels: [],
    sortKey: 0,
    prState: 'none',
    prDraft: false,
    ciState: 'none',
    ciRequiredTotal: 0,
    ciRequiredPassed: 0,
    ciRequiredFailed: 0,
    ciRequiredPending: 0,
    reviewState: 'none',
    unresolvedThreadCount: 0,
    githubSyncStatus: 'ok',
    gitState: 'clean',
    gitAheadCount: 0,
    gitBehindCount: 0,
    hasUntracked: false,
    hasConflicts: false,
    sessionAttentionNeeded: false,
    branches: [],
    prCount: 0,
    prOpenCount: 0,
    prMergedCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as TaskRecord;
}

function fleetRow(taskId: string, patch: Partial<FleetSessionStatus> = {}): FleetSessionStatus {
  return {
    taskId,
    taskTitle: taskId,
    slot: 'primary',
    backendType: 'tmux',
    sessionStatus: 'active',
    isBusy: false,
    attentionNeeded: false,
    trustPromptShowing: false,
    delivered: true,
    createdAt: 0,
    ...patch,
  };
}

function board(tasks: TaskRecord[]): BoardSnapshot {
  return { repos: [], pillars: [], labels: [], tracks: [], tasks, savedViews: [], uiState: {} } as BoardSnapshot;
}

const release = (prNumber: number, stage: PRReleaseStatus['stage']): PRReleaseStatus => ({
  repoSlug: 'o/r',
  prNumber,
  stage,
  confidence: 'confirmed',
  artifacts: [],
  checkedAt: 0,
});

const noFilter = { query: '', repoId: '', showShipped: false };

describe('cardState', () => {
  it('is new until a session has ever run, stopped after', () => {
    expect(cardState(task('a'), [])).toBe('new');
    expect(cardState(task('a', { sessionId: 's1' }), [])).toBe('stopped');
  });

  it('follows the live session', () => {
    expect(cardState(task('a'), [fleetRow('a', { isBusy: true })])).toBe('working');
    expect(cardState(task('a'), [fleetRow('a')])).toBe('idle');
    expect(cardState(task('a'), [fleetRow('a', { attentionNeeded: true, isBusy: true })])).toBe('needs-you');
  });
});

describe('prStage', () => {
  it('maps a merged PR through its release stage', () => {
    const merged = branch({ prState: 'merged' });
    expect(prStage(merged)).toBe('merged');
    expect(prStage(merged, release(10, 'awaiting-build'))).toBe('merged');
    expect(prStage(merged, release(10, 'rc-built'))).toBe('rc-built');
    expect(prStage(merged, release(10, 'ga'))).toBe('ga');
  });

  it('treats a draft flag on an open PR as draft', () => {
    expect(prStage(branch({ prDraft: true }))).toBe('draft');
  });
});

describe('buildCardTree', () => {
  it('nests subtasks under their parent, recursively', () => {
    const tree = buildCardTree(
      board([task('p'), task('c', { parentTaskId: 'p' }), task('g', { parentTaskId: 'c' })]),
      [],
      new Map(),
      noFilter,
    );
    expect(tree.map((n) => n.task.id)).toEqual(['p']);
    expect(tree[0]?.children[0]?.task.id).toBe('c');
    expect(tree[0]?.children[0]?.children[0]?.task.id).toBe('g');
  });

  it('keeps an orphaned subtask at the top level', () => {
    const tree = buildCardTree(board([task('c', { parentTaskId: 'gone' })]), [], new Map(), noFilter);
    expect(tree.map((n) => n.task.id)).toEqual(['c']);
  });

  it('orders by last activity, newest first, a parent by the newest card in its family', () => {
    const tree = buildCardTree(
      board([
        task('old', { title: 'Old', updatedAt: 100 }),
        task('p', { title: 'Parent', updatedAt: 50, sessionId: 's' }),
        task('c1', { title: 'C1', updatedAt: 60, parentTaskId: 'p' }),
        task('c2', { title: 'C2', updatedAt: 70, parentTaskId: 'p', sessionId: 's' }),
        task('g', { title: 'G', updatedAt: 10, parentTaskId: 'c1', sessionId: 's' }),
        task('mid', { title: 'Mid', updatedAt: 150 }),
      ]),
      // The grandchild's agent was active most recently of all, which lifts
      // its whole family above cards that changed later than the parent did.
      [fleetRow('g', { lastActivityAt: 200 })],
      new Map(),
      noFilter,
    );
    expect(tree.map((n) => n.task.id)).toEqual(['p', 'mid', 'old']);
    expect(tree[0]?.children.map((n) => n.task.id)).toEqual(['c1', 'c2']);
    expect(tree[0]?.children[0]?.lastActiveAt).toBe(60);
    expect(tree[0]?.children[0]?.children[0]?.lastActiveAt).toBe(200);
  });

  it('keeps working cards on top in a fixed order, however their activity times move', () => {
    const order = (activity: Record<string, number>) =>
      buildCardTree(
        board([
          task('idle', { title: 'Idle', updatedAt: 500 }),
          task('w2', { title: 'Beta', updatedAt: 1 }),
          task('w1', { title: 'Alpha', updatedAt: 1 }),
        ]),
        [
          fleetRow('idle', { lastActivityAt: activity.idle }),
          fleetRow('w1', { isBusy: true, lastActivityAt: activity.w1 }),
          fleetRow('w2', { isBusy: true, lastActivityAt: activity.w2 }),
        ],
        new Map(),
        noFilter,
      ).map((n) => n.task.id);
    expect(order({ idle: 900, w1: 10, w2: 20 })).toEqual(['w1', 'w2', 'idle']);
    expect(order({ idle: 900, w1: 20, w2: 10 })).toEqual(['w1', 'w2', 'idle']);
  });

  it('hides a shipped family only when every member is shipped', () => {
    const shipped = (id: string, patch: Partial<TaskRecord> = {}) =>
      task(id, { sessionId: 's', branches: [branch({ taskId: id, prState: 'merged', prNumber: 1 })], ...patch });
    const releases = new Map([
      ['p', [release(1, 'ga')]],
      ['c', [release(1, 'ga')]],
    ]);
    const allShipped = buildCardTree(board([shipped('p'), shipped('c', { parentTaskId: 'p' })]), [], releases, noFilter);
    expect(allShipped).toHaveLength(0);

    const childLive = buildCardTree(
      board([shipped('p'), shipped('c', { parentTaskId: 'p' })]),
      [fleetRow('c')],
      releases,
      noFilter,
    );
    expect(childLive.map((n) => n.task.id)).toEqual(['p']);

    const shown = buildCardTree(board([shipped('p')]), [], releases, { ...noFilter, showShipped: true });
    expect(shown).toHaveLength(1);
  });

  it('lists shipped families after active ones', () => {
    const shippedOrchestrator = task('o', {
      isOrchestrator: true,
      sessionId: 's',
      branches: [branch({ taskId: 'o', prState: 'closed', prNumber: 1 })],
    });
    const tree = buildCardTree(board([shippedOrchestrator, task('a')]), [], new Map(), {
      ...noFilter,
      showShipped: true,
    });
    expect(tree.map((n) => n.task.id)).toEqual(['a', 'o']);
  });

  it('keeps the whole family when a subtask matches the search', () => {
    const tree = buildCardTree(
      board([task('parent'), task('needle', { parentTaskId: 'parent' })]),
      [],
      new Map(),
      { ...noFilter, query: 'needle' },
    );
    expect(tree.map((n) => n.task.id)).toEqual(['parent']);
  });
});
