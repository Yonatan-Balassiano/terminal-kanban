/**
 * Small concurrency helpers shared by the services that fan out over the
 * network.
 *
 * Both the artifacts rail and the release-status resolver walk a list of remote
 * lookups against the same MCP gateway, so they share one cap rather than each
 * deciding independently how hard to push it.
 */

/** Per-list concurrency for remote lookups; lists are small, the server shared. */
export const MAX_CONCURRENT_LOOKUPS = 4;

/** Runs tasks with a small concurrency cap, preserving input order. */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]!);
    }
  });

  await Promise.all(workers);
  return results;
}
