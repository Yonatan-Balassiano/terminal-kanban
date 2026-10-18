// Browser history for the web board: one entry per card visited, so back and
// forward (buttons, mouse, Alt+←/→, or [ and ]) walk between cards. No React
// here, so tests can import it directly.

/** What one history entry remembers. */
export interface CardVisit {
  taskId: string | null;
  /**
   * Whether this visit showed the card's session in the terminal. Going back
   * shows it again only if it was shown the first time: showing a session
   * opens it, which starts the agent, and stepping back through history must
   * never start an agent nobody asked for.
   */
  terminal: boolean;
}

const HASH_PREFIX = '#card/';

export function cardHash(taskId: string | null): string {
  return taskId ? `${HASH_PREFIX}${encodeURIComponent(taskId)}` : '';
}

export function cardFromHash(hash: string): string | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const id = decodeURIComponent(hash.slice(HASH_PREFIX.length));
  return id || null;
}

/**
 * Reads an entry back. `state` is whatever `history.state` holds — this app's
 * own `CardVisit`, or nothing at all when the page was opened from a typed or
 * pasted `#card/<id>` link, which then counts as a visit without the terminal.
 */
export function visitFrom(state: unknown, hash: string): CardVisit {
  if (state && typeof state === 'object' && 'taskId' in state) {
    const { taskId, terminal } = state as Partial<CardVisit>;
    return { taskId: typeof taskId === 'string' ? taskId : null, terminal: terminal === true };
  }
  return { taskId: cardFromHash(hash), terminal: false };
}

function url(taskId: string | null): string {
  return `${location.pathname}${location.search}${cardHash(taskId)}`;
}

/** Adds an entry, unless it would repeat the current one. */
export function pushVisit(visit: CardVisit): void {
  const current = visitFrom(history.state, location.hash);
  if (current.taskId === visit.taskId) {
    // Same card again: only record that the terminal is now showing it.
    if (visit.terminal && !current.terminal) history.replaceState(visit, '', url(visit.taskId));
    return;
  }
  history.pushState(visit, '', url(visit.taskId));
}

/** Points the current entry at a card without adding one — arrow-key moves. */
export function replaceVisit(visit: CardVisit): void {
  history.replaceState(visit, '', url(visit.taskId));
}
