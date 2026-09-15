import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GitService, parseWorktreeEntries, parseWorktreeList } from '../src/services/git.js';

describe('parseWorktreeEntries', () => {
  const PORCELAIN = [
    'worktree /repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/tsachis/create-enterprise-app-skill',
    '',
    'worktree /repo-worktrees/detached',
    'HEAD 2222222222222222222222222222222222222222',
    'detached',
    '',
    'worktree /repo-worktrees/gone',
    'HEAD 3333333333333333333333333333333333333333',
    'branch refs/heads/ab/gone-0001',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  it('reads each checkout with the branch it is on', () => {
    expect(parseWorktreeEntries(PORCELAIN)).toEqual([
      { path: '/repo', branch: 'tsachis/create-enterprise-app-skill', prunable: false },
      { path: '/repo-worktrees/detached', branch: null, prunable: false },
      { path: '/repo-worktrees/gone', branch: 'ab/gone-0001', prunable: true },
    ]);
  });

  it('still lists every path for callers that only want paths', () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      '/repo',
      '/repo-worktrees/detached',
      '/repo-worktrees/gone',
    ]);
  });
});

describe('GitService.findBranchCheckoutAsync', () => {
  let root: string;
  let repo: string;

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  beforeEach(() => {
    // realpath: macOS tmpdir is a symlink, and git reports the resolved path.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agentboard-checkout-')));
    repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=a@test', '-c', 'user.name=a', 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a branch checked out in the main checkout', async () => {
    // Arrange — the card that could not open: its branch was the main checkout's.
    git(repo, 'checkout', '-q', '-b', 'tsachis/skill');

    // Act + Assert
    await expect(new GitService().findBranchCheckoutAsync(repo, 'tsachis/skill')).resolves.toBe(repo);
  });

  it('finds a branch checked out in a linked worktree', async () => {
    // Arrange
    const worktree = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'ab/other-0002', worktree);

    // Act + Assert
    await expect(new GitService().findBranchCheckoutAsync(repo, 'ab/other-0002')).resolves.toBe(
      worktree,
    );
  });

  it('returns null for a branch no checkout is on', async () => {
    // Arrange
    git(repo, 'branch', 'ab/free-0003');

    // Act + Assert
    await expect(new GitService().findBranchCheckoutAsync(repo, 'ab/free-0003')).resolves.toBeNull();
  });

  it('ignores a worktree whose directory is gone', async () => {
    // Arrange — git keeps the entry until a prune; its path is no place to work.
    const worktree = join(root, 'deleted');
    git(repo, 'worktree', 'add', '-q', '-b', 'ab/deleted-0004', worktree);
    rmSync(worktree, { recursive: true, force: true });

    // Act + Assert
    await expect(
      new GitService().findBranchCheckoutAsync(repo, 'ab/deleted-0004'),
    ).resolves.toBeNull();
  });
});
