export function getInitialCreateTaskOptionIndex(
  options: ReadonlyArray<{ id: string | null }>,
  activeId?: string | null,
): number {
  if (options.length === 0 || activeId == null) {
    return 0;
  }

  const matchIndex = options.findIndex((option) => option.id === activeId);
  return matchIndex >= 0 ? matchIndex : 0;
}

export function getInitialCreateTaskRepoIndex(
  repos: ReadonlyArray<{ id: string }>,
  activeRepoId?: string,
): number {
  return getInitialCreateTaskOptionIndex(repos, activeRepoId);
}

export function getNextCreateTaskOptionIndex(
  currentIndex: number,
  optionCount: number,
  delta: number,
): number {
  if (optionCount <= 1) {
    return 0;
  }

  const nextIndex = currentIndex + delta;
  if (nextIndex < 0) {
    return optionCount - 1;
  }
  if (nextIndex >= optionCount) {
    return 0;
  }
  return nextIndex;
}

export function getNextCreateTaskRepoIndex(
  currentIndex: number,
  repoCount: number,
  delta: number,
): number {
  return getNextCreateTaskOptionIndex(currentIndex, repoCount, delta);
}
