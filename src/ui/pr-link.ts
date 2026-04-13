import type { RepoRecord, TaskRecord } from '../types/index.js';

export function getRepoGithubUrl(repo: RepoRecord): string | undefined {
  if (repo.githubUrl) {
    return repo.githubUrl;
  }

  if (repo.githubOwner && repo.githubRepo) {
    return `https://github.com/${repo.githubOwner}/${repo.githubRepo}`;
  }

  return undefined;
}

export function hasOpenPR(task: TaskRecord): boolean {
  return task.prState === 'open' || task.prState === 'draft';
}

export function getTaskPRUrl(
  task: Pick<TaskRecord, 'prUrl' | 'prNumber'>,
  repo?: RepoRecord,
): string | undefined {
  if (task.prUrl) {
    return task.prUrl;
  }

  if (task.prNumber === undefined || repo === undefined) {
    return undefined;
  }

  const repoUrl = getRepoGithubUrl(repo);
  if (!repoUrl) {
    return undefined;
  }

  return `${repoUrl}/pull/${task.prNumber}`;
}
