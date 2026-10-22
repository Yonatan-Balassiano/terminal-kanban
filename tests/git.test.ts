import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GitService } from '../src/services/git.js';
import { LocalTransport } from '../src/services/transport/local.js';

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

describe('GitService new branches start from the latest origin base', () => {
  let root: string;
  let bare: string;
  let upstream: string;
  let local: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-git-base-'));
    bare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare]);

    upstream = join(root, 'upstream');
    execFileSync('git', ['clone', bare, upstream]);
    writeFileSync(join(upstream, 'README.md'), 'hello\n');
    git(upstream, 'add', '-A');
    commit(upstream, 'init');
    git(upstream, 'push', 'origin', 'main');

    local = join(root, 'local');
    execFileSync('git', ['clone', bare, local]);

    // Someone else lands work on main after this clone last pulled.
    writeFileSync(join(upstream, 'later.txt'), 'later\n');
    git(upstream, 'add', '-A');
    commit(upstream, 'landed later');
    git(upstream, 'push', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches the base and branches a new worktree from origin, not the stale local base', async () => {
    const worktreePath = join(root, 'wt');

    await new GitService().createWorktreeAsync(local, worktreePath, 'feature/new', 'main');

    expect(git(worktreePath, 'log', '--oneline', '-1')).toContain('landed later');
    // The user's own local main is not moved.
    expect(git(local, 'log', '--oneline', '-1', 'main')).toContain('init');
  });

  it('does not make the new branch track the base', async () => {
    const worktreePath = join(root, 'wt');

    await new GitService().createWorktreeAsync(local, worktreePath, 'feature/new', 'main');

    expect(() => git(worktreePath, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
  });

  it('falls back to the last fetched origin base when the remote is unreachable', async () => {
    git(local, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const worktreePath = join(root, 'wt');

    await new GitService().createWorktreeAsync(local, worktreePath, 'feature/new', 'main');

    expect(git(worktreePath, 'log', '--oneline', '-1')).toContain('init');
  });

  it('leaves an existing branch where it is', async () => {
    git(local, 'branch', 'feature/old', 'main');
    const worktreePath = join(root, 'wt');

    await new GitService().createWorktreeAsync(local, worktreePath, 'feature/old', 'main');

    expect(git(worktreePath, 'log', '--oneline', '-1')).toContain('init');
  });

  it('ensureBranch also starts a new branch from the fetched origin base', () => {
    new GitService().ensureBranch(local, 'feature/chat', 'main');

    expect(git(local, 'log', '--oneline', '-1')).toContain('landed later');
    expect(git(local, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/chat');
  });
});

describe('GitService.updateRef', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'agentboard-ref-'));
    execFileSync('git', ['init', '-b', 'main', repo]);
    git(repo, 'config', 'core.excludesFile', '/dev/null');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '-A');
    commit(repo, 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('keeps archived work reachable after its branch is gone', async () => {
    // Arrange — the whole point of archiving under a ref rather than leaving
    // the commit on a branch: deleting a card often means the branch goes too,
    // and the agent's work has to survive that. Simulates the real sequence:
    // commit the worktree's uncommitted changes, pin them, then move the
    // branch away as a deletion would.
    writeFileSync(join(repo, 'investigation.md'), 'a 257-line report\n');
    const service = new GitService();
    const sha = await service.stageAndCommitWip(repo, '[agentboard archive] task-1');
    expect(sha).not.toBeNull();

    // Act
    await service.updateRef(repo, 'refs/agentboard/archive/task-1', sha!);
    git(repo, 'checkout', '-q', '--detach', 'HEAD~1');
    git(repo, 'branch', '-D', 'main');

    // Assert — the commit is still reachable by ref, and still holds the file.
    expect(git(repo, 'rev-parse', 'refs/agentboard/archive/task-1')).toBe(sha);
    expect(git(repo, 'show', '--stat', '--format=', 'refs/agentboard/archive/task-1')).toContain(
      'investigation.md',
    );
    // And recoverable with ordinary git, no bespoke restore path.
    expect(git(repo, 'show', 'refs/agentboard/archive/task-1:investigation.md')).toBe(
      'a 257-line report',
    );
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

  it('writes its temporary excludes file inside the repo, not this process tmpdir', async () => {
    // Arrange — the transport may be ssh to a host where this process's
    // tmpdir() (macOS `/var/folders/...`) does not exist and cannot be made.
    writeFileSync(join(repo, 'notes.txt'), 'legit change\n');
    const transport = new LocalTransport();
    const written: string[] = [];
    const write = transport.writeFileIfChanged.bind(transport);
    transport.writeFileIfChanged = async (path, content, mode) => {
      written.push(path);
      return write(path, content, mode);
    };
    const service = new GitService(transport);

    // Act
    await service.stageAndCommitWip(repo, '[teleport wip] test');

    // Assert
    expect(written).toHaveLength(1);
    expect(written[0].startsWith(realpathSync(join(repo, '.git')))).toBe(true);
    expect(existsSync(written[0])).toBe(false);
  });
});
