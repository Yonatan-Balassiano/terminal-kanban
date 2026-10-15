// Keyboard model for the web board: which card the arrows land on, and which
// command a key press means. Pure, so tests can import it. The keys are the
// TUI's (internal/tui/model.go), minus the ones about columns and panes.

import { findPRRelease, prBranches, type CardNode, type PRReleaseStatus, type TaskBranchRecord, type TaskRecord } from './model';

export interface VisibleCard {
  node: CardNode;
  parentId?: string;
}

/** The cards in screen order, skipping the children of collapsed cards. */
export function visibleCards(tree: readonly CardNode[], collapsed: ReadonlySet<string>): VisibleCard[] {
  const out: VisibleCard[] = [];
  const walk = (nodes: readonly CardNode[], parentId?: string) => {
    for (const node of nodes) {
      out.push({ node, parentId });
      if (node.children.length > 0 && !collapsed.has(node.task.id)) {
        walk(node.children, node.task.id);
      }
    }
  };
  walk(tree);
  return out;
}

export type Command =
  | 'up'
  | 'down'
  | 'collapse'
  | 'expand'
  | 'show'
  | 'new'
  | 'rename'
  | 'delete'
  | 'restart'
  | 'create-pr'
  | 'merge-pr'
  | 'comment-pr'
  | 'open-pr'
  | 'open-checks'
  | 'sync'
  | 'toggle-detail'
  | 'search'
  | 'clear'
  | 'needs-you'
  | 'repo-prev'
  | 'repo-next'
  | 'help'
  | { repoIndex: number };

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

const KEYMAP: Record<string, Command> = {
  ArrowUp: 'up',
  k: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'collapse',
  h: 'collapse',
  ArrowRight: 'expand',
  l: 'expand',
  Enter: 'show',
  t: 'show',
  n: 'new',
  r: 'rename',
  d: 'delete',
  R: 'restart',
  c: 'create-pr',
  m: 'merge-pr',
  j: 'comment-pr',
  o: 'open-pr',
  v: 'open-checks',
  s: 'sync',
  e: 'toggle-detail',
  '/': 'search',
  Escape: 'clear',
  '!': 'needs-you',
  ',': 'repo-prev',
  '.': 'repo-next',
  '?': 'help',
};

/** The command for a key press, or null to let the browser have it. */
export function commandForKey(event: KeyLike): Command | null {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
  if (/^[1-9]$/.test(event.key)) {
    return { repoIndex: Number(event.key) - 1 };
  }
  return KEYMAP[event.key] ?? null;
}

/** Where the arrows go from the selected card. Returns the id to select. */
export function navigate(
  cards: readonly VisibleCard[],
  selectedId: string | null,
  command: 'up' | 'down' | 'collapse' | 'expand',
  collapsed: ReadonlySet<string>,
): { select?: string; toggle?: string } {
  const index = cards.findIndex((card) => card.node.task.id === selectedId);
  if (index === -1) {
    const first = cards[0];
    return first ? { select: first.node.task.id } : {};
  }
  const current = cards[index] as VisibleCard;
  const id = current.node.task.id;
  const hasChildren = current.node.children.length > 0;
  switch (command) {
    case 'up':
      return { select: cards[Math.max(0, index - 1)]?.node.task.id };
    case 'down':
      return { select: cards[Math.min(cards.length - 1, index + 1)]?.node.task.id };
    case 'collapse':
      if (hasChildren && !collapsed.has(id)) return { toggle: id };
      return current.parentId ? { select: current.parentId } : {};
    case 'expand':
      if (hasChildren && collapsed.has(id)) return { toggle: id };
      return hasChildren ? { select: current.node.children[0]?.task.id } : {};
  }
}

/** The pull request `o`, `v`, `m` and `j` act on: the first open one, else the newest merged one. */
export function primaryPR(task: TaskRecord): TaskBranchRecord | undefined {
  const prs = prBranches(task);
  return (
    prs.find((branch) => branch.prState === 'open' || branch.prState === 'draft') ??
    [...prs].reverse().find((branch) => branch.prState === 'merged') ??
    prs[0]
  );
}

/**
 * What `o` opens: the PR — or, once it has merged and a release candidate is
 * built but not yet in production, the dev portal page of the artifact holding
 * it back, as the TUI does (`getTaskDevPortalURL`).
 */
export function openTarget(task: TaskRecord, releases: readonly PRReleaseStatus[] | undefined): string | undefined {
  const branch = primaryPR(task);
  if (!branch) return undefined;
  const release = findPRRelease(branch, releases);
  if (branch.prState === 'merged' && release && (release.stage === 'rc-built' || release.stage === 'rolling-out')) {
    const blocking = release.artifacts.find((artifact) => artifact.gates && artifact.stage !== 'ga');
    if (blocking) return `https://wix-bo.com/dev/project/${blocking.artifactName}`;
  }
  return branch.prUrl;
}

export interface Shortcut {
  keys: string;
  label: string;
}

export const SHORTCUTS: Array<{ section: string; items: Shortcut[] }> = [
  {
    section: 'Navigate',
    items: [
      { keys: '↑  k  ↓', label: 'Previous / next card' },
      { keys: '←  h  →  l', label: 'Collapse / expand, or go to parent / first subtask' },
      { keys: 'Enter  t', label: 'Show the card’s session in the terminal' },
      { keys: '!', label: 'Jump to a card that needs you' },
      { keys: '/', label: 'Search' },
      { keys: 'Esc', label: 'Clear search, close a dialog' },
      { keys: ',  .  1–9', label: 'Previous / next repo, pick a repo (again to clear)' },
      { keys: 'e', label: 'Show / hide the details pane' },
    ],
  },
  {
    section: 'Card',
    items: [
      { keys: 'n', label: 'New card (optionally a subtask of the selected one)' },
      { keys: 'r', label: 'Rename' },
      { keys: 'd', label: 'Delete (uncommitted work is archived)' },
      { keys: 'R', label: 'Restart the session (keeps the conversation)' },
    ],
  },
  {
    section: 'Pull request',
    items: [
      { keys: 'o', label: 'Open the PR, or the dev portal once built' },
      { keys: 'v', label: 'Open PR checks' },
      { keys: 'c', label: 'Create the PR now' },
      { keys: 'm', label: 'Merge the PR' },
      { keys: 'j', label: 'Comment on the PR' },
      { keys: 's', label: 'Sync with GitHub now' },
    ],
  },
  { section: 'Help', items: [{ keys: '?', label: 'This list' }] },
];
