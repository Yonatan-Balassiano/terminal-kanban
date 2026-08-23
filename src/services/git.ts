import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { GitState } from '../types/index.js';
import type { Db } from '../db/index.js';
import { LocalTransport } from './transport/local.js';
import { ExecError, TransportUnreachableError, type ExecTransport } from './transport/types.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/**
 * Fetch/push/ls-remote and anything that materialises a working tree (`checkout`,
 * `worktree add`, `status`) routinely outlive the transport default — 30s local,
 * 10s over SSH. Worse, the SSH transport reports a timeout as
 * `TransportUnreachableError`, so a merely slow monorepo checkout would be
 * misdiagnosed as a dead host.
 */
const LONG_RUNNING_TIMEOUT_MS = 300_000;

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

export function parseWorktreeList(output: string): string[] {
  const worktrees: string[] = [];

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      worktrees.push(line.slice('worktree '.length).trim());
    }
  }

  return worktrees;
}

function gitArgv(repoPath: string, ...args: string[]): string[] {
  return ['git', '-C', repoPath, ...args];
}

function worktreeAddArgv(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  reuseBranch: boolean,
): string[] {
  return reuseBranch
    ? gitArgv(repoPath, 'worktree', 'add', worktreePath, branch)
    : gitArgv(repoPath, 'worktree', 'add', '-b', branch, worktreePath, baseBranch);
}

function describeError(error: unknown): string {
  if (error instanceof ExecError) {
    return (error.stderr || error.stdout || error.message).trim();
  }
  const withOutput = error as { stderr?: unknown; stdout?: unknown };
  const detail = String(withOutput?.stderr ?? '') || String(withOutput?.stdout ?? '');
  if (detail.trim().length > 0) {
    return detail.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function isExecTransport(value: unknown): value is ExecTransport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ExecTransport>;
  return typeof candidate.exec === 'function' && typeof candidate.isRemote === 'boolean';
}

/**
 * Runs git against whichever host the injected transport points at.
 *
 * The synchronous methods predate the transport and still have callers that
 * cannot await; they run on the local machine only and throw when this service
 * is bound to a remote transport. Every one of them has an `...Async` twin that
 * works on either host — prefer those.
 */
export class GitService {
  private readonly transport: ExecTransport;

  /** `Db` is accepted for the legacy `new GitService(db)` call sites; git never reads it. */
  constructor(transportOrDb?: ExecTransport | Db) {
    this.transport = isExecTransport(transportOrDb) ? transportOrDb : new LocalTransport();
  }

  // --------------- Private helpers ---------------------------

  private async run(
    argv: readonly string[],
    cwd: string,
    timeoutMs?: number,
  ): Promise<string> {
    try {
      const result = await this.transport.exec(argv, { cwd, timeoutMs });
      return result.stdout.trim();
    } catch (error: unknown) {
      // An unreachable host is not a git failure; callers need to tell them apart.
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      throw new Error(`Git command failed: ${argv.join(' ')}\n${describeError(error)}`);
    }
  }

  private runSync(argv: readonly string[], cwd: string): string {
    const [command, ...args] = argv;
    try {
      const stdout = execFileSync(command, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return stdout.trim();
    } catch (error: unknown) {
      throw new Error(`Git command failed: ${argv.join(' ')}\n${describeError(error)}`);
    }
  }

  private requireLocal(method: string): void {
    if (this.transport.isRemote) {
      throw new Error(
        `GitService.${method}() runs locally only; call ${method}Async() for transport ${this.transport.id}.`,
      );
    }
  }

  // --------------- Public API --------------------------------

  async validateRepo(repoPath: string): Promise<void> {
    if (!(await this.transport.exists(repoPath))) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }
    try {
      await this.run(gitArgv(repoPath, 'rev-parse', '--git-dir'), repoPath);
    } catch (error: unknown) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      throw new Error(`Not a git repository: ${repoPath}`);
    }
  }

  async defaultBranch(repoPath: string): Promise<string> {
    try {
      const ref = await this.run(
        gitArgv(repoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'),
        repoPath,
      );
      // e.g. "origin/main" → "main"
      return ref.replace(/^origin\//, '');
    } catch (error: unknown) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      return 'main';
    }
  }

  async currentBranch(repoPath: string): Promise<string> {
    return this.run(gitArgv(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'), repoPath);
  }

  async currentHead(repoPath: string): Promise<string> {
    return this.run(gitArgv(repoPath, 'rev-parse', 'HEAD'), repoPath);
  }

  /** Used to unwind a WIP commit a failed teleport already made. */
  async resetHard(repoPath: string, ref: string): Promise<void> {
    await this.run(gitArgv(repoPath, 'reset', '--hard', ref), repoPath, LONG_RUNNING_TIMEOUT_MS);
  }

  async remoteBranchExists(repoPath: string, branch: string, remote = 'origin'): Promise<boolean> {
    try {
      await this.run(
        gitArgv(repoPath, 'ls-remote', '--exit-code', '--heads', remote, branch),
        repoPath,
        LONG_RUNNING_TIMEOUT_MS,
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      return false;
    }
  }

  branchExists(repoPath: string, branch: string): boolean {
    this.requireLocal('branchExists');
    try {
      this.runSync(
        gitArgv(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`),
        repoPath,
      );
      return true;
    } catch {
      return false;
    }
  }

  async branchExistsAsync(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.run(
        gitArgv(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`),
        repoPath,
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof TransportUnreachableError) {
        throw error;
      }
      return false;
    }
  }

  createBranch(repoPath: string, branch: string, base: string): void {
    this.requireLocal('createBranch');
    this.runSync(gitArgv(repoPath, 'checkout', '-b', branch, base), repoPath);
  }

  async createBranchAsync(repoPath: string, branch: string, base: string): Promise<void> {
    await this.run(gitArgv(repoPath, 'checkout', '-b', branch, base), repoPath, LONG_RUNNING_TIMEOUT_MS);
  }

  checkoutBranch(repoPath: string, branch: string): void {
    this.requireLocal('checkoutBranch');
    this.runSync(gitArgv(repoPath, 'checkout', branch), repoPath);
  }

  async checkoutBranchAsync(repoPath: string, branch: string): Promise<void> {
    await this.run(gitArgv(repoPath, 'checkout', branch), repoPath, LONG_RUNNING_TIMEOUT_MS);
  }

  ensureBranch(repoPath: string, branch: string, baseBranch: string): void {
    if (this.branchExists(repoPath, branch)) {
      this.checkoutBranch(repoPath, branch);
    } else {
      this.createBranch(repoPath, branch, baseBranch);
    }
  }

  async ensureBranchAsync(repoPath: string, branch: string, baseBranch: string): Promise<void> {
    if (await this.branchExistsAsync(repoPath, branch)) {
      await this.checkoutBranchAsync(repoPath, branch);
      return;
    }
    await this.createBranchAsync(repoPath, branch, baseBranch);
  }

  createWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch: string): void {
    this.requireLocal('createWorktree');
    const reuseBranch = this.branchExists(repoPath, branch);
    this.runSync(
      worktreeAddArgv(repoPath, worktreePath, branch, baseBranch, reuseBranch),
      repoPath,
    );
  }

  async createWorktreeAsync(
    repoPath: string,
    worktreePath: string,
    branch: string,
    baseBranch: string,
  ): Promise<void> {
    const reuseBranch = await this.branchExistsAsync(repoPath, branch);

    // A branch pushed from another host is invisible here until it is fetched:
    // this clone has no local ref for it, only `origin` does. Without this, a
    // teleported task's worktree would silently start a fresh branch from
    // baseBranch instead of picking up the pushed commits.
    if (!reuseBranch && (await this.remoteBranchExists(repoPath, branch))) {
      await this.run(gitArgv(repoPath, 'fetch', 'origin', branch), repoPath, LONG_RUNNING_TIMEOUT_MS);
      await this.run(
        gitArgv(repoPath, 'worktree', 'add', '-b', branch, worktreePath, `origin/${branch}`),
        repoPath,
        LONG_RUNNING_TIMEOUT_MS,
      );
      return;
    }

    await this.run(
      worktreeAddArgv(repoPath, worktreePath, branch, baseBranch, reuseBranch),
      repoPath,
      LONG_RUNNING_TIMEOUT_MS,
    );
  }

  removeWorktree(repoPath: string, worktreePath: string): void {
    this.requireLocal('removeWorktree');
    this.runSync(gitArgv(repoPath, 'worktree', 'remove', '--force', worktreePath), repoPath);
  }

  async removeWorktreeAsync(repoPath: string, worktreePath: string): Promise<void> {
    await this.run(
      gitArgv(repoPath, 'worktree', 'remove', '--force', worktreePath),
      repoPath,
      LONG_RUNNING_TIMEOUT_MS,
    );
  }

  pruneWorktrees(repoPath: string): void {
    this.requireLocal('pruneWorktrees');
    this.runSync(gitArgv(repoPath, 'worktree', 'prune', '--expire', 'now'), repoPath);
  }

  async pruneWorktreesAsync(repoPath: string): Promise<void> {
    await this.run(gitArgv(repoPath, 'worktree', 'prune', '--expire', 'now'), repoPath);
  }

  listWorktrees(repoPath: string): string[] {
    this.requireLocal('listWorktrees');
    return parseWorktreeList(
      this.runSync(gitArgv(repoPath, 'worktree', 'list', '--porcelain'), repoPath),
    );
  }

  async listWorktreesAsync(repoPath: string): Promise<string[]> {
    return parseWorktreeList(
      await this.run(gitArgv(repoPath, 'worktree', 'list', '--porcelain'), repoPath),
    );
  }

  async getWorkspaceStatus(repoPath: string): Promise<GitWorkspaceStatus> {
    const output = await this.run(
      gitArgv(repoPath, 'status', '--porcelain=1', '-b'),
      repoPath,
      LONG_RUNNING_TIMEOUT_MS,
    );
    return parseGitWorkspaceStatus(output);
  }

  async fetch(repoPath: string, remote = 'origin'): Promise<void> {
    await this.run(gitArgv(repoPath, 'fetch', remote), repoPath, LONG_RUNNING_TIMEOUT_MS);
  }

  async rebaseOnto(repoPath: string, upstream: string): Promise<void> {
    await this.run(gitArgv(repoPath, 'rebase', upstream), repoPath, LONG_RUNNING_TIMEOUT_MS);
  }

  async pushCurrentBranch(
    repoPath: string,
    branch: string,
    remote = 'origin',
    setUpstream = true,
    force = false,
  ): Promise<void> {
    const args = ['push'];
    if (force) {
      args.push('--force');
    }
    if (setUpstream) {
      args.push('--set-upstream');
    }
    args.push(remote, branch);
    await this.run(gitArgv(repoPath, ...args), repoPath, LONG_RUNNING_TIMEOUT_MS);
  }

  /**
   * `git add -A` and commit, skipping anything that looks like a secret.
   *
   * Applies a temporary `core.excludesFile` for the one `git add`, rather than
   * writing to `.git/info/exclude`, so a concurrent operation on the same repo
   * never sees the exclusion and nothing is left behind if this is interrupted.
   * Returns null when nothing was staged — an already-clean tree has no WIP
   * commit to make.
   */
  async stageAndCommitWip(repoPath: string, message: string): Promise<string | null> {
    const excludePatterns = [
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'id_rsa',
      'id_ed25519',
      '*credentials*.json',
    ];
    const excludeFile = join(tmpdir(), `agentboard-wip-exclude-${randomBytes(6).toString('hex')}`);
    await this.transport.writeFileIfChanged(excludeFile, excludePatterns.join('\n') + '\n');
    try {
      await this.run(
        gitArgv(repoPath, '-c', `core.excludesFile=${excludeFile}`, 'add', '-A'),
        repoPath,
        LONG_RUNNING_TIMEOUT_MS,
      );
      const status = await this.run(gitArgv(repoPath, 'status', '--porcelain'), repoPath);
      if (status.length === 0) {
        return null;
      }
      await this.run(gitArgv(repoPath, 'commit', '-m', message), repoPath, LONG_RUNNING_TIMEOUT_MS);
      return this.run(gitArgv(repoPath, 'rev-parse', 'HEAD'), repoPath);
    } finally {
      await this.transport.removeDir(excludeFile).catch(() => undefined);
    }
  }
}
