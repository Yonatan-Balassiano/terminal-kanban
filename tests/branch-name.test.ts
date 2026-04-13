import { describe, expect, it } from 'vitest';
import {
  createTaskBranchName,
  isLegacyTaskBranchName,
  normalizeTaskBranchSlug,
  resolveTaskBranchName,
  renameTaskBranchName,
} from '../src/services/branch-name.js';

describe('branch naming', () => {
  it('derives a branch from the task title and 4 random digits', () => {
    expect(createTaskBranchName('Friday thing')).toMatch(/^ab\/friday-thing-\d{4}$/);
  });

  it('falls back to a safe task slug when the title has no branch-safe characters', () => {
    expect(normalizeTaskBranchSlug('!!!')).toBe('task');
    expect(createTaskBranchName('!!!')).toMatch(/^ab\/task-\d{4}$/);
  });

  it('keeps the existing 4-digit suffix when an unstarted task is renamed', () => {
    expect(renameTaskBranchName('Better title', 'ab/friday-thing-0427')).toBe(
      'ab/better-title-0427',
    );
  });

  it('detects the legacy task-id branch format', () => {
    expect(isLegacyTaskBranchName('d60c4749', 'ab/d60c4749')).toBe(true);
    expect(isLegacyTaskBranchName('d60c4749', 'ab/rl-noes-0427')).toBe(false);
  });

  it('replaces legacy task-id branches with the title-based format', () => {
    expect(resolveTaskBranchName('RL noes', 'd60c4749', 'ab/d60c4749')).toMatch(
      /^ab\/rl-noes-\d{4}$/,
    );
  });
});
