import { execFile, execSync, type ExecFileException } from 'child_process';
import { existsSync } from 'fs';
import type { GitState } from '../types/index.js';
import type { Db } from '../db/index.js';

export interface GitWorkspaceStatus {
  branch: string;
  gitState: GitState;
  aheadCount: number;
  behindCount: number;
  hasUntracked: boolean;
  hasConflicts: boolean;
}

function parseAheadBehind(header: string): { aheadCount: number; behindCount: number } {
  const bracket = header.match(/\[(.+)\]$/);
  if (!bracket) {
    return { aheadCount: 0, behindCount: 0 };
  }

  const aheadMatch = bracket[1].match(/ahead (\d+)/);
  const behindMatch = bracket[1].match(/behind (\d+)/);
  return {
    aheadCount: Number.parseInt(aheadMatch?.[1] ?? '0', 10) || 0,
    behindCount: Number.parseInt(behindMatch?.[1] ?? '0', 10) || 0,
  };
}

export function parseGitWorkspaceStatus(output: string): GitWorkspaceStatus {
  const lines = output.split('\n').filter((line) => line.length > 0);
  const header = lines[0] ?? '';
  const entries = lines.slice(1);
  const detached =
    header.includes('HEAD (no branch)') ||
    header.includes('HEAD (detached') ||
    header.startsWith('## HEAD');
  const branchMatch = header.match(/^## ([^.\s]+|HEAD)(?:\.{3}.*)?$/);
  const branch = detached ? 'HEAD' : (branchMatch?.[1] ?? 'HEAD');
  const { aheadCount, behindCount } = parseAheadBehind(header);
  const hasUntracked = entries.some((line) => line.startsWith('?? '));
  const hasConflicts = entries.some((line) => {
    const x = line[0] ?? '';
    const y = line[1] ?? '';
    return x === 'U' || y === 'U' || ['AA', 'DD', 'AU', 'UA', 'DU', 'UD'].includes(`${x}${y}`);
  });
  const hasDirtyTracked = entries.some((line) => {
    if (line.startsWith('?? ')) {
      return false;
    }
    const x = line[0] ?? '';
    const y = line[1] ?? '';
    return x !== ' ' || y !== ' ';
  });

  let gitState: GitState = 'clean';
  if (detached) {
    gitState = 'detached';
  } else if (hasConflicts) {
    gitState = 'conflicted';
  } else if (hasDirtyTracked) {
    gitState = 'dirty';
  } else if (hasUntracked) {
    gitState = 'untracked';
  }

  return {
    branch,
    gitState,
    aheadCount,
    behindCount,
    hasUntracked,
    hasConflicts,
  };
}

export class GitService {
  constructor(_db?: Db) {}

  // --------------- Private helper ----------------------------

  private exec(cmd: string, cwd: string): string {
    try {
      return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Git command failed: ${cmd}\n${msg}`);
    }
  }

  private execFileAsync(cmd: string, args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        },
        (
          error: ExecFileException | null,
          stdout: string,
          stderr: string,
        ) => {
          if (error) {
            const detail = (stderr || stdout || error.message).trim();
            reject(new Error(`Git command failed: ${cmd} ${args.join(' ')}\n${detail}`));
            return;
          }

          resolve(stdout.trim());
        },
      );
    });
  }

  // --------------- Public API --------------------------------

  validateRepo(repoPath: string): void {
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }
    try {
      execSync(`git -C "${repoPath}" rev-parse --git-dir`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(`Not a git repository: ${repoPath}`);
    }
  }

  async defaultBranch(repoPath: string): Promise<string> {
    try {
      const ref = await this.execFileAsync(
        'git',
        ['-C', repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
        repoPath,
      );
      // e.g. "origin/main" → "main"
      return ref.replace(/^origin\//, '');
    } catch {
      return 'main';
    }
  }

  currentBranch(repoPath: string): string {
    return this.exec(`git -C "${repoPath}" rev-parse --abbrev-ref HEAD`, repoPath);
  }

  async remoteBranchExists(repoPath: string, branch: string, remote = 'origin'): Promise<boolean> {
    try {
      await this.execFileAsync(
        'git',
        ['-C', repoPath, 'ls-remote', '--exit-code', '--heads', remote, branch],
        repoPath,
      );
      return true;
    } catch {
      return false;
    }
  }

  branchExists(repoPath: string, branch: string): boolean {
    try {
      execSync(`git -C "${repoPath}" show-ref --verify --quiet refs/heads/${branch}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  createBranch(repoPath: string, branch: string, base: string): void {
    this.exec(`git -C "${repoPath}" checkout -b ${branch} ${base}`, repoPath);
  }

  checkoutBranch(repoPath: string, branch: string): void {
    this.exec(`git -C "${repoPath}" checkout ${branch}`, repoPath);
  }

  ensureBranch(repoPath: string, branch: string, baseBranch: string): void {
    if (this.branchExists(repoPath, branch)) {
      this.checkoutBranch(repoPath, branch);
    } else {
      this.createBranch(repoPath, branch, baseBranch);
    }
  }

  createWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch: string): void {
    if (this.branchExists(repoPath, branch)) {
      this.exec(`git -C "${repoPath}" worktree add "${worktreePath}" ${branch}`, repoPath);
      return;
    }

    this.exec(
      `git -C "${repoPath}" worktree add -b "${branch}" "${worktreePath}" ${baseBranch}`,
      repoPath,
    );
  }

  removeWorktree(repoPath: string, worktreePath: string): void {
    this.exec(`git -C "${repoPath}" worktree remove --force "${worktreePath}"`, repoPath);
  }

  listWorktrees(repoPath: string): string[] {
    const output = this.exec(`git -C "${repoPath}" worktree list --porcelain`, repoPath);
    const worktrees: string[] = [];

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        worktrees.push(line.slice('worktree '.length).trim());
      }
    }

    return worktrees;
  }

  async getWorkspaceStatus(repoPath: string): Promise<GitWorkspaceStatus> {
    const output = await this.execFileAsync(
      'git',
      ['-C', repoPath, 'status', '--porcelain=1', '-b'],
      repoPath,
    );
    return parseGitWorkspaceStatus(output);
  }

  async fetch(repoPath: string, remote = 'origin'): Promise<void> {
    await this.execFileAsync('git', ['-C', repoPath, 'fetch', remote], repoPath);
  }

  async rebaseOnto(repoPath: string, upstream: string): Promise<void> {
    await this.execFileAsync('git', ['-C', repoPath, 'rebase', upstream], repoPath);
  }

  async pushCurrentBranch(
    repoPath: string,
    branch: string,
    remote = 'origin',
    setUpstream = true,
  ): Promise<void> {
    const args = ['-C', repoPath, 'push'];
    if (setUpstream) {
      args.push('--set-upstream');
    }
    args.push(remote, branch);
    await this.execFileAsync('git', args, repoPath);
  }
}
