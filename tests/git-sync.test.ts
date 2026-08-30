import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/services/git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('GitService.syncWorktreeIntoMain', () => {
  let root: string;
  let main: string;
  let worktree: string;
  const branch = 'ab/feature-1234';
  const svc = new GitService();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-git-sync-'));
    main = join(root, 'main');

    git(root, 'init', '-b', 'master', 'main');
    git(main, 'config', 'user.email', 'test@example.com');
    git(main, 'config', 'user.name', 'Test');
    git(main, 'config', 'commit.gpgsign', 'false');

    writeFileSync(join(main, 'base.txt'), 'base\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'initial');

    // Create the task worktree on its own branch.
    worktree = join(root, 'wt');
    git(main, 'worktree', 'add', '-b', branch, worktree, 'master');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('mirrors the worktree (commits + staged + unstaged + untracked) into the main checkout', async () => {
    // A committed change on the branch.
    writeFileSync(join(worktree, 'committed.txt'), 'committed work\n');
    git(worktree, 'add', 'committed.txt');
    git(worktree, 'commit', '-m', 'add committed work');
    const branchTip = git(worktree, 'rev-parse', 'HEAD');

    // A staged (but uncommitted) change.
    writeFileSync(join(worktree, 'base.txt'), 'base\nstaged edit\n');
    git(worktree, 'add', 'base.txt');

    // An unstaged change to a tracked file.
    writeFileSync(join(worktree, 'committed.txt'), 'committed work\nunstaged edit\n');

    // An untracked new file.
    writeFileSync(join(worktree, 'untracked.txt'), 'untracked content\n');

    // Divergent local change in the main checkout that should be discarded by the reset.
    writeFileSync(join(main, 'base.txt'), 'stale main change\n');

    const mainHeadBefore = git(main, 'rev-parse', 'HEAD');

    const result = await svc.syncWorktreeIntoMain({
      repoPath: main,
      worktreePath: worktree,
      branch,
    });

    // Main HEAD now equals the branch tip.
    expect(git(main, 'rev-parse', 'HEAD')).toBe(branchTip);
    expect(result.mainBranch).toBe('master');
    expect(result.previousMainHead).toBe(mainHeadBefore);
    expect(result.appliedPatch).toBe(true);
    expect(result.copiedUntracked).toBe(1);

    // Committed branch work is present.
    expect(existsSync(join(main, 'committed.txt'))).toBe(true);

    // Staged + unstaged uncommitted changes were applied on top.
    expect(readFileSync(join(main, 'base.txt'), 'utf8')).toBe('base\nstaged edit\n');
    expect(readFileSync(join(main, 'committed.txt'), 'utf8')).toBe(
      'committed work\nunstaged edit\n',
    );

    // Untracked file was copied.
    expect(readFileSync(join(main, 'untracked.txt'), 'utf8')).toBe('untracked content\n');
  });

  it('rejects when the task has no separate worktree', async () => {
    await expect(
      svc.syncWorktreeIntoMain({ repoPath: main, worktreePath: main, branch: 'master' }),
    ).rejects.toThrow('no separate worktree');
  });

  it('rejects when the branch does not exist', async () => {
    await expect(
      svc.syncWorktreeIntoMain({ repoPath: main, worktreePath: worktree, branch: 'ab/missing' }),
    ).rejects.toThrow('Branch not found');
  });
});
