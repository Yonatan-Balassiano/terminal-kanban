// Pure read-model for the web board: card state, PR stage, and the
// parent → subtask tree. No React here, so tests can import it directly.

import type {
  BoardSnapshot,
  DoctorCheck,
  FleetSessionStatus,
  PRReleaseStatus,
  ReleaseStage,
  TaskBranchRecord,
  TaskRecord,
} from '../../src/types/index.js';

export type { BoardSnapshot, DoctorCheck, FleetSessionStatus, PRReleaseStatus, TaskBranchRecord, TaskRecord };

/**
 * A card's own state. Deliberately not the board's track (backlog / PR /
 * shipping / done): those describe the pull requests, which carry their own
 * stage below. A card is only ever new, running, or stopped.
 */
export type CardState = 'new' | 'needs-you' | 'working' | 'idle' | 'stopped';

export const CARD_STATE_LABEL: Record<CardState, string> = {
  new: 'New',
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  stopped: 'Stopped',
};

export function cardState(task: TaskRecord, fleet: readonly FleetSessionStatus[]): CardState {
  const live = fleet.filter((row) => row.taskId === task.id);
  if (live.length > 0) {
    if (task.sessionAttentionNeeded || live.some((row) => row.attentionNeeded || row.trustPromptShowing)) {
      return 'needs-you';
    }
    return live.some((row) => row.isBusy) ? 'working' : 'idle';
  }
  return task.sessionId || task.lastSessionCwd ? 'stopped' : 'new';
}

/** Where one pull request stands, from opened to in production. */
export type PRStage =
  | 'no-pr'
  | 'draft'
  | 'open'
  | 'closed'
  | 'merged'
  | 'rc-built'
  | 'rolling-out'
  | 'ga';

export const PR_STAGE_LABEL: Record<PRStage, string> = {
  'no-pr': 'No PR',
  draft: 'Draft',
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
  'rc-built': 'RC built',
  'rolling-out': 'Rolling out',
  ga: "GA'd",
};

const RELEASE_TO_STAGE: Partial<Record<ReleaseStage, PRStage>> = {
  'rc-built': 'rc-built',
  'rolling-out': 'rolling-out',
  ga: 'ga',
};

export function findPRRelease(
  branch: TaskBranchRecord,
  releases: readonly PRReleaseStatus[] | undefined,
): PRReleaseStatus | undefined {
  if (!branch.prNumber || !releases) {
    return undefined;
  }
  return releases.find((status) => status.prNumber === branch.prNumber);
}

export function prStage(branch: TaskBranchRecord, release?: PRReleaseStatus): PRStage {
  switch (branch.prState) {
    case 'none':
      return 'no-pr';
    case 'draft':
      return 'draft';
    case 'open':
      return branch.prDraft ? 'draft' : 'open';
    case 'closed':
      return 'closed';
    case 'merged':
      return (release && RELEASE_TO_STAGE[release.stage]) ?? 'merged';
  }
}

/** A PR that needs nothing more: in production, closed, or merged with nothing to ship. */
export function prIsFinished(branch: TaskBranchRecord, release?: PRReleaseStatus): boolean {
  const stage = prStage(branch, release);
  return stage === 'ga' || stage === 'closed' || (stage === 'merged' && release?.stage === 'no-artifact');
}

export function prBranches(task: TaskRecord): TaskBranchRecord[] {
  return task.branches.filter((branch) => branch.prNumber !== undefined && branch.prState !== 'none');
}

/** A card with nothing left to do: no live session, and every PR finished. */
export function isShipped(
  task: TaskRecord,
  state: CardState,
  releases: readonly PRReleaseStatus[] | undefined,
): boolean {
  if (state !== 'stopped') {
    return false;
  }
  const prs = prBranches(task);
  return prs.length > 0 && prs.every((branch) => prIsFinished(branch, findPRRelease(branch, releases)));
}

export interface CardNode {
  task: TaskRecord;
  state: CardState;
  shipped: boolean;
  /** When this card was last active: its agent's last activity, or its own last change. */
  lastActiveAt: number;
  /**
   * What the card sorts by: the most recent `lastActiveAt` in its family (the
   * card and every card under it), with a working card counting as now.
   */
  sortActiveAt: number;
  children: CardNode[];
}

export interface BoardFilter {
  query: string;
  repoId: string;
  showShipped: boolean;
}

/**
 * When a card was last active. A live session's own activity (its agent
 * writing to the conversation) is the real signal; `updatedAt` covers what the
 * card itself did — a PR, CI, a session opening or closing — and is the only
 * signal for a card with no live session. Sync polls do not move it.
 */
export function lastActiveAt(task: TaskRecord, fleet: readonly FleetSessionStatus[]): number {
  let latest = task.updatedAt;
  for (const row of fleet) {
    if (row.taskId === task.id && row.lastActivityAt !== undefined && row.lastActivityAt > latest) {
      latest = row.lastActivityAt;
    }
  }
  return latest;
}

/**
 * Most recently active first, at every level, a parent ranked by the most
 * recent card in its family. A working card counts as active now, so several
 * working cards hold their places (alphabetically) on top instead of trading
 * them on every poll as each writes to its conversation in turn.
 */
function compareNodes(a: CardNode, b: CardNode): number {
  if (a.sortActiveAt !== b.sortActiveAt) {
    return b.sortActiveAt - a.sortActiveAt;
  }
  return (
    a.task.title.localeCompare(b.task.title, undefined, { numeric: true, sensitivity: 'base' }) ||
    a.task.id.localeCompare(b.task.id)
  );
}

function nodeMatches(node: CardNode, filter: BoardFilter, repoLabel: (id?: string) => string): boolean {
  if (filter.repoId && node.task.repoId !== filter.repoId) {
    return false;
  }
  const query = filter.query.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const haystack = [
    node.task.title,
    node.task.description ?? '',
    node.task.sessionName ?? '',
    repoLabel(node.task.repoId),
    ...node.task.branches.flatMap((branch) => [branch.branchName, branch.prNumber ? `#${branch.prNumber}` : '']),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/** True when this node or anything under it is still active. */
function familyActive(node: CardNode): boolean {
  return !node.shipped || node.children.some(familyActive);
}

/**
 * Builds the parent → subtask forest. A card whose parent is gone is shown at
 * the top level rather than lost. A family is kept whole when any member
 * matches the filter, and hidden as shipped only when every member is.
 */
export function buildCardTree(
  board: BoardSnapshot,
  fleet: readonly FleetSessionStatus[],
  releases: ReadonlyMap<string, PRReleaseStatus[]>,
  filter: BoardFilter,
): CardNode[] {
  const repoLabel = (id?: string) => board.repos.find((repo) => repo.id === id)?.label ?? '';
  const nodes = new Map<string, CardNode>();
  for (const task of board.tasks) {
    const state = cardState(task, fleet);
    const active = lastActiveAt(task, fleet);
    nodes.set(task.id, {
      task,
      state,
      shipped: isShipped(task, state, releases.get(task.id)),
      lastActiveAt: active,
      sortActiveAt: state === 'working' ? Number.POSITIVE_INFINITY : active,
      children: [],
    });
  }

  const roots: CardNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.task.parentTaskId ? nodes.get(node.task.parentTaskId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // A family is as recent as its most recent member.
  const rollUp = (node: CardNode): number => {
    for (const child of node.children) {
      node.sortActiveAt = Math.max(node.sortActiveAt, rollUp(child));
    }
    return node.sortActiveAt;
  };
  roots.forEach(rollUp);

  const sortDeep = (list: CardNode[]) => {
    list.sort(compareNodes);
    list.forEach((node) => sortDeep(node.children));
  };
  sortDeep(roots);
  // Shipped families go last, so "Show shipped" adds history below the live work.
  roots.sort((a, b) => Number(!familyActive(a)) - Number(!familyActive(b)));

  const anyMatches = (node: CardNode): boolean =>
    nodeMatches(node, filter, repoLabel) || node.children.some(anyMatches);

  return roots.filter((root) => (filter.showShipped || familyActive(root)) && anyMatches(root));
}

export function countFamily(node: CardNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countFamily(child), 0);
}

export function relativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
