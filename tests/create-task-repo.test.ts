import { describe, expect, it } from 'vitest';
import {
  getInitialCreateTaskOptionIndex,
  getInitialCreateTaskRepoIndex,
  getNextCreateTaskOptionIndex,
  getNextCreateTaskRepoIndex,
} from '../src/ui/create-task-repo.js';

describe('create task repo picker helpers', () => {
  const repos = [{ id: 'repo-1' }, { id: 'repo-2' }];

  it('defaults to the active repo when it exists', () => {
    expect(getInitialCreateTaskRepoIndex(repos, 'repo-2')).toBe(1);
  });

  it('falls back to the first repo when the active repo is not present', () => {
    expect(getInitialCreateTaskRepoIndex(repos, 'missing-repo')).toBe(0);
  });

  it('wraps repo navigation in both directions', () => {
    expect(getNextCreateTaskRepoIndex(0, 2, -1)).toBe(1);
    expect(getNextCreateTaskRepoIndex(1, 2, 1)).toBe(0);
  });

  it('supports generic option selection helpers for pillar-style pickers', () => {
    const options = [{ id: null }, { id: 'pillar-1' }, { id: 'pillar-2' }];
    expect(getInitialCreateTaskOptionIndex(options, 'pillar-2')).toBe(2);
    expect(getNextCreateTaskOptionIndex(0, options.length, -1)).toBe(2);
    expect(getNextCreateTaskOptionIndex(2, options.length, 1)).toBe(0);
  });
});
