import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BaseBranchSyncService } from '../src/services/base-branch-sync.js';
import { GitService } from '../src/services/git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string, message: string): void {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=a@test', '-c', 'user.name=a', 'commit', '-q', '-m', message);
}

describe('GitService.fastForwardLocalBranchAsync', () => {
  let root: string;
  let upstream: string;
  let local: string;
  const service = new GitService();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentboard-base-sync-'));
    const bare = join(root, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    upstream = join(root, 'upstream');
    execFileSync('git', ['clone', '-q', bare, upstream]);
    commit(upstream, 'README.md', 'init');
    git(upstream, 'push', '-q', 'origin', 'main');

    local = join(root, 'local');
    execFileSync('git', ['clone', '-q', bare, local]);

    commit(upstream, 'later.txt', 'landed later');
    git(upstream, 'push', '-q', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fast-forwards a clean checkout of the branch, files included', async () => {
    const outcome = await service.fastForwardLocalBranchAsync(local, 'main');

    expect(outcome.status).toBe('updated');
    expect(git(local, 'log', '--oneline', '-1')).toContain('landed later');
    expect(readFileSync(join(local, 'later.txt'), 'utf8')).toBe('landed later\n');
  });

  it('moves only the ref when the branch is not checked out anywhere', async () => {
    git(local, 'checkout', '-q', '-b', 'feature/mine');

    const outcome = await service.fastForwardLocalBranchAsync(local, 'main');

    expect(outcome.status).toBe('updated');
    expect(git(local, 'log', '--oneline', '-1', 'main')).toContain('landed later');
    expect(git(local, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/mine');
  });

  it('skips a checkout with uncommitted changes and leaves it alone', async () => {
    writeFileSync(join(local, 'README.md'), 'my edit\n');

    const outcome = await service.fastForwardLocalBranchAsync(local, 'main');

    expect(outcome).toMatchObject({ status: 'skipped' });
    expect(git(local, 'log', '--oneline', '-1')).toContain('init');
    expect(readFileSync(join(local, 'README.md'), 'utf8')).toBe('my edit\n');
  });

  it('skips a branch with local commits instead of rebasing them', async () => {
    commit(local, 'mine.txt', 'local only');

    const outcome = await service.fastForwardLocalBranchAsync(local, 'main');

    expect(outcome).toMatchObject({ status: 'skipped' });
    expect(git(local, 'log', '--oneline', '-1')).toContain('local only');
  });

  it('reports up to date when there is nothing to do', async () => {
    git(local, 'pull', '-q');

    expect(await service.fastForwardLocalBranchAsync(local, 'main')).toEqual({ status: 'up-to-date' });
  });

  it('skips when origin cannot be reached', async () => {
    git(local, 'remote', 'set-url', 'origin', join(root, 'missing.git'));

    const outcome = await service.fastForwardLocalBranchAsync(local, 'main');

    expect(outcome).toMatchObject({ status: 'skipped' });
    expect(git(local, 'log', '--oneline', '-1')).toContain('init');
  });
});

describe('BaseBranchSyncService', () => {
  let db: Db;
  let root: string;

  beforeEach(() => {
    db = openDb(':memory:');
    root = mkdtempSync(join(tmpdir(), 'agentboard-base-sync-svc-'));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function addRepo(id: string, path: string, base: string): void {
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, id, path, null, null, base, null, 'ok', 1, 1);
  }

  it('syncs every repo on its own base branch, logs each, and skips missing paths', async () => {
    const calls: string[] = [];
    const fakeGit = {
      fastForwardLocalBranchAsync: async (path: string, branch: string) => {
        calls.push(`${path}:${branch}`);
        return { status: 'up-to-date' as const };
      },
    } as unknown as GitService;
    addRepo('a', root, 'master');
    addRepo('b', join(root, 'gone'), 'main');
    const logs: string[] = [];

    const results = await new BaseBranchSyncService(db, fakeGit, (m) => logs.push(m)).runOnce();

    expect(calls).toEqual([`${root}:master`]);
    expect(results).toHaveLength(1);
    expect(logs).toEqual(['[base-sync] a master: up to date']);
  });

  it('keeps going when one repo throws', async () => {
    const fakeGit = {
      fastForwardLocalBranchAsync: async (path: string) => {
        if (path.endsWith('bad')) throw new Error('boom');
        return { status: 'up-to-date' as const };
      },
    } as unknown as GitService;
    const bad = join(root, 'bad');
    execFileSync('mkdir', [bad]);
    addRepo('a-bad', bad, 'main');
    addRepo('b-ok', root, 'main');

    const results = await new BaseBranchSyncService(db, fakeGit, () => {}).runOnce();

    expect(results.map((r) => r.outcome.status)).toEqual(['skipped', 'up-to-date']);
  });
});
