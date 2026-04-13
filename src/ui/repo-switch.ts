export function getNextActiveRepoId(
  repos: ReadonlyArray<{ id: string }>,
  activeRepoId: string | undefined,
  delta: number,
): string | undefined {
  if (repos.length === 0) {
    return undefined;
  }

  const repoIds = [undefined, ...repos.map((repo) => repo.id)];
  const currentIndex = repoIds.findIndex((repoId) => repoId === activeRepoId);
  const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeCurrentIndex + delta + repoIds.length) % repoIds.length;
  return repoIds[nextIndex];
}
