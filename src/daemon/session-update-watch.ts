/** Refcounts which task IDs have at least one RPC client watching session_update for them. */

const counts = new Map<string, number>();

export function trackWatchedSessionTask(previous: string | null, next: string | null): void {
  if (previous && previous.length > 0) {
    const c = (counts.get(previous) ?? 0) - 1;
    if (c <= 0) {
      counts.delete(previous);
    } else {
      counts.set(previous, c);
    }
  }
  if (next && next.length > 0) {
    counts.set(next, (counts.get(next) ?? 0) + 1);
  }
}

export function shouldEmitSessionUpdate(taskId: string): boolean {
  return (counts.get(taskId) ?? 0) > 0;
}
