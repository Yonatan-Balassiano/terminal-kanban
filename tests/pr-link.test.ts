import { describe, expect, it } from 'vitest';
import { getRepoGithubUrl, getTaskPRUrl, hasOpenPR } from '../src/ui/pr-link.js';

describe('PR link helpers', () => {
  it('prefers the repo githubUrl when present', () => {
    expect(
      getRepoGithubUrl({
        id: 'repo-1',
        label: 'Repo',
        path: '/repo',
        githubOwner: 'org',
        githubRepo: 'proj',
        githubUrl: 'https://github.example/org/proj',
        defaultBaseBranch: 'main',
        health: 'ok',
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toBe('https://github.example/org/proj');
  });

  it('builds a PR URL from repo metadata and task PR number', () => {
    expect(
      getTaskPRUrl(
        { prNumber: 42, prUrl: undefined },
        {
          id: 'repo-1',
          label: 'Repo',
          path: '/repo',
          githubOwner: 'org',
          githubRepo: 'proj',
          defaultBaseBranch: 'main',
          health: 'ok',
          createdAt: 1,
          updatedAt: 1,
        },
      ),
    ).toBe('https://github.com/org/proj/pull/42');
  });

  it('prefers the stored PR URL when available', () => {
    expect(
      getTaskPRUrl(
        { prNumber: 42, prUrl: 'https://github.com/org/proj/pull/42' },
        undefined,
      ),
    ).toBe('https://github.com/org/proj/pull/42');
  });

  it('treats open and draft PRs as browser-openable', () => {
    expect(hasOpenPR({ prState: 'open' } as never)).toBe(true);
    expect(hasOpenPR({ prState: 'draft' } as never)).toBe(true);
    expect(hasOpenPR({ prState: 'merged' } as never)).toBe(false);
  });
});
