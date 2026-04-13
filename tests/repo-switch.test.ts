import { describe, expect, it } from 'vitest';
import { getNextActiveRepoId } from '../src/ui/repo-switch.js';

describe('getNextActiveRepoId', () => {
  const repos = [{ id: 'repo-1' }, { id: 'repo-2' }];

  it('cycles forward through all, repo-1, repo-2', () => {
    expect(getNextActiveRepoId(repos, undefined, 1)).toBe('repo-1');
    expect(getNextActiveRepoId(repos, 'repo-1', 1)).toBe('repo-2');
    expect(getNextActiveRepoId(repos, 'repo-2', 1)).toBeUndefined();
  });

  it('cycles backward through all, repo-2, repo-1', () => {
    expect(getNextActiveRepoId(repos, undefined, -1)).toBe('repo-2');
    expect(getNextActiveRepoId(repos, 'repo-2', -1)).toBe('repo-1');
    expect(getNextActiveRepoId(repos, 'repo-1', -1)).toBeUndefined();
  });
});
