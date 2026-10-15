import { describe, expect, it } from 'vitest';
import { commandForKey, navigate, openTarget, visibleCards } from '../web/src/keys.js';
import type { CardNode, PRReleaseStatus, TaskBranchRecord, TaskRecord } from '../web/src/model.js';

function node(id: string, children: CardNode[] = []): CardNode {
  return { task: { id } as TaskRecord, state: 'idle', shipped: false, children };
}

// p ─┬─ c1 ── g
//    └─ c2
// q
const tree = [node('p', [node('c1', [node('g')]), node('c2')]), node('q')];
const ids = (cards: ReturnType<typeof visibleCards>) => cards.map((card) => card.node.task.id);

describe('visibleCards', () => {
  it('lists cards in screen order and hides collapsed subtrees', () => {
    expect(ids(visibleCards(tree, new Set()))).toEqual(['p', 'c1', 'g', 'c2', 'q']);
    expect(ids(visibleCards(tree, new Set(['c1'])))).toEqual(['p', 'c1', 'c2', 'q']);
    expect(ids(visibleCards(tree, new Set(['p'])))).toEqual(['p', 'q']);
  });
});

describe('navigate', () => {
  const none = new Set<string>();
  const cards = visibleCards(tree, none);

  it('moves up and down, stopping at the ends', () => {
    expect(navigate(cards, 'c1', 'down', none)).toEqual({ select: 'g' });
    expect(navigate(cards, 'q', 'down', none)).toEqual({ select: 'q' });
    expect(navigate(cards, 'p', 'up', none)).toEqual({ select: 'p' });
    expect(navigate(cards, 'gone', 'down', none)).toEqual({ select: 'p' });
  });

  it('left folds an open card, else goes to its parent; right unfolds, else goes to the first subtask', () => {
    expect(navigate(cards, 'c1', 'collapse', none)).toEqual({ toggle: 'c1' });
    expect(navigate(cards, 'g', 'collapse', none)).toEqual({ select: 'c1' });
    expect(navigate(cards, 'q', 'collapse', none)).toEqual({});
    const folded = new Set(['p']);
    expect(navigate(visibleCards(tree, folded), 'p', 'expand', folded)).toEqual({ toggle: 'p' });
    expect(navigate(cards, 'p', 'expand', none)).toEqual({ select: 'c1' });
  });
});

describe('commandForKey', () => {
  it('maps the TUI keys and leaves modified keys to the browser', () => {
    expect(commandForKey({ key: 'n' })).toBe('new');
    expect(commandForKey({ key: 'R' })).toBe('restart');
    expect(commandForKey({ key: 'Enter' })).toBe('show');
    expect(commandForKey({ key: '3' })).toEqual({ repoIndex: 2 });
    expect(commandForKey({ key: 'r', metaKey: true })).toBeNull();
    expect(commandForKey({ key: 'z' })).toBeNull();
  });
});

describe('openTarget', () => {
  const branch = (patch: Partial<TaskBranchRecord>) =>
    ({ id: 'b', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', prState: 'open', ...patch }) as TaskBranchRecord;
  const task = (b: TaskBranchRecord) => ({ id: 't', branches: [b] }) as unknown as TaskRecord;
  const release = (stage: PRReleaseStatus['stage']): PRReleaseStatus => ({
    repoSlug: 'o/r',
    prNumber: 7,
    stage,
    confidence: 'confirmed',
    checkedAt: 0,
    artifacts: [{ artifactName: 'com.wixpress.thing', shortName: 'thing', stage: 'rc-built', gates: true } as never],
  });

  it('opens the PR, or the dev portal while a merged change is built but not in production', () => {
    expect(openTarget(task(branch({})), undefined)).toBe('https://github.com/o/r/pull/7');
    const merged = task(branch({ prState: 'merged' }));
    expect(openTarget(merged, [release('rc-built')])).toBe('https://wix-bo.com/dev/project/com.wixpress.thing');
    expect(openTarget(merged, [release('ga')])).toBe('https://github.com/o/r/pull/7');
  });
});
