import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GitService } from '../src/services/git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, '-c', 'user.email=a@test', '-c', 'user.name=a', 'commit', '-m', message);
}

describe('GitService.createWorktreeAsync', () => {
  let root: string;
  let bare: string;
  let cloneA: string;
  let cloneB: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-git-'));
    bare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);

    cloneA = join(root, 'clone-a');
    execFileSync('git', ['clone', bare, cloneA]);
    writeFileSync(join(cloneA, 'README.md'), 'hello\n');
    git(cloneA, 'add', '-A');
    commit(cloneA, 'init');
    git(cloneA, 'push', 'origin', 'main');

    cloneB = join(root, 'clone-b');
    execFileSync('git', ['clone', bare, cloneB]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches and reuses a branch pushed from another clone, instead of branching from base', async () => {
    // Arrange — push a feature branch from clone A; clone B never fetched it.
    git(cloneA, 'checkout', '-b', 'feature/x');
    writeFileSync(join(cloneA, 'file.txt'), 'work in progress\n');
    git(cloneA, 'add', '-A');
    commit(cloneA, 'wip');
    git(cloneA, 'push', 'origin', 'feature/x');

    const service = new GitService();
    const worktreePath = join(root, 'wt-b');

    // Act
    await service.createWorktreeAsync(cloneB, worktreePath, 'feature/x', 'main');

    // Assert — the worktree carries the pushed commit, not a fresh branch off base.
    expect(git(worktreePath, 'log', '--oneline', '-1')).toContain('wip');
  });

  it('still branches from base when neither a local nor a remote ref exists', async () => {
    // Arrange
    const service = new GitService();
    const worktreePath = join(root, 'wt-fresh');

    // Act
    await service.createWorktreeAsync(cloneB, worktreePath, 'brand-new-branch', 'main');

    // Assert
    expect(git(worktreePath, 'log', '--oneline', '-1')).toContain('init');
  });
});

describe('GitService.stageAndCommitWip', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agentboard-wip-'));
    execFileSync('git', ['init', '-b', 'main', repo]);
    // This suite asserts on which files show up as untracked, so the developer's
    // own global excludes file has to be out of the picture. Without this the
    // `.env` case below fails for anyone whose ~/.gitignore lists `.env` —
    // git hides it, `git status --porcelain` comes back empty, and the test
    // reports a bug in code that behaved correctly.
    git(repo, 'config', 'core.excludesFile', '/dev/null');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '-A');
    commit(repo, 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns null when the tree is already clean', async () => {
    // Arrange
    const service = new GitService();

    // Act
    const sha = await service.stageAndCommitWip(repo, '[teleport wip] test');

    // Assert
    expect(sha).toBeNull();
  });

  it('commits everything except secret-looking files', async () => {
    // Arrange
    writeFileSync(join(repo, 'notes.txt'), 'legit change\n');
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');
    const service = new GitService();

    // Act
    const sha = await service.stageAndCommitWip(repo, '[teleport wip] test');

    // Assert
    expect(sha).not.toBeNull();
    const committed = git(repo, 'show', '--stat', '--format=', 'HEAD');
    expect(committed).toContain('notes.txt');
    expect(committed).not.toContain('.env');
    // Excluded from the commit, not deleted from disk.
    expect(git(repo, 'status', '--porcelain')).toContain('.env');
  });
});
