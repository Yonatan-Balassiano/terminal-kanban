import type { Db } from '../db/index.js';
import type { DoctorCheck, RemoteConfig, SessionRecord, TaskLocation } from '../types/index.js';
import type { BoardService } from './board.js';
import type { SessionManager } from './session-manager.js';
import type { WorktreeService } from './worktree.js';
import { GitService } from './git.js';
import { TransportRegistry, type ExecTransport } from './transport/index.js';
import { createRemoteProvider } from './remote/index.js';
import { resolveTaskBranchName } from './branch-name.js';
import { claudeTranscriptPath } from './claude-transcript.js';

export type TeleportDirection = 'local-to-remote' | 'remote-to-local';

export class TeleportBlockedError extends Error {
  constructor(readonly checks: DoctorCheck[]) {
    super(
      `Teleport preflight failed: ${checks
        .filter((c) => c.status === 'fail')
        .map((c) => c.message)
        .join('; ')}`
    );
    this.name = 'TeleportBlockedError';
  }
}

export interface TeleportResult {
  checks: DoctorCheck[];
  session: SessionRecord;
  wipCommitted: boolean;
  transcriptCopied: boolean;
}

interface TaskRow {
  id: string;
  title: string;
  kind: string | null;
  repo_id: string | null;
  location: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  session_id: string | null;
  secondary_session_id: string | null;
}

interface RepoRow {
  id: string;
  label: string;
  path: string;
  remote_path: string | null;
  default_base_branch: string | null;
}

function sourceLocation(direction: TeleportDirection): TaskLocation {
  return direction === 'local-to-remote' ? 'local' : 'remote';
}

function destLocation(direction: TeleportDirection): TaskLocation {
  return direction === 'local-to-remote' ? 'remote' : 'local';
}

/**
 * Moves a task's live agent session between agentboard's local host and its
 * configured SSH remote — working tree and conversation included — the way
 * `openSession` already resumes a card by its stable `agent_session_id`
 * regardless of which host writes to it next.
 *
 * Scoped to what a single owner actually hits: a card with more than one
 * repo/branch, or a live secondary session, is refused rather than guessed
 * at. Re-teleporting the same task back to a host it already visited can
 * leave a stale local branch ref there that `GitService.createWorktreeAsync`
 * will reuse as-is instead of re-fetching — a known gap, not yet hit in
 * practice for a single-owner board.
 */
export class TeleportService {
  constructor(
    private db: Db,
    private board: BoardService,
    private sessions: SessionManager,
    private worktrees: WorktreeService,
    private localGit: GitService,
    private transports: TransportRegistry,
    private remote?: RemoteConfig
  ) {}

  private loadTask(taskId: string): TaskRow {
    const row = this.db
      .prepare<[string], TaskRow>(
        `SELECT id, title, kind, repo_id, location, branch_name, worktree_path,
                session_id, secondary_session_id
           FROM tasks WHERE id = ?`
      )
      .get(taskId);
    if (!row) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return row;
  }

  private loadRepo(repoId: string): RepoRow {
    const row = this.db
      .prepare<
        [string],
        RepoRow
      >(`SELECT id, label, path, remote_path, default_base_branch FROM repos WHERE id = ?`)
      .get(repoId);
    if (!row) {
      throw new Error(`Repo not found: ${repoId}`);
    }
    return row;
  }

  private branchCount(taskId: string): number {
    return (
      this.db
        .prepare<
          [string],
          { count: number }
        >('SELECT COUNT(*) AS count FROM task_branches WHERE task_id = ?')
        .get(taskId)?.count ?? 0
    );
  }

  private gitFor(location: TaskLocation): GitService {
    return location === 'local' ? this.localGit : new GitService(this.transports.getRemote());
  }

  private transportFor(location: TaskLocation): ExecTransport {
    return this.transports.forLocation(location);
  }

  /** Where the task's checkout sits today — refused to more than one, see class docs. */
  private sourceCwd(task: TaskRow, repo: RepoRow, location: TaskLocation): string {
    const repoPath = location === 'local' ? repo.path : repo.remote_path!;
    return task.worktree_path ?? repoPath;
  }

  private branchName(task: TaskRow): string {
    return resolveTaskBranchName(task.title, task.id, task.branch_name ?? undefined);
  }

  private async resolveClaudeConfigDir(transport: ExecTransport): Promise<string> {
    const result = await transport.exec([
      'sh',
      '-c',
      'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    ]);
    const dir = result.stdout.trim();
    if (!dir) {
      throw new Error('Could not resolve the Claude config directory.');
    }
    return dir;
  }

  private agentSessionId(task: TaskRow): string | null {
    if (!task.session_id) {
      return null;
    }
    const row = this.db
      .prepare<
        [string],
        { agent_session_id: string | null }
      >('SELECT agent_session_id FROM sessions WHERE id = ?')
      .get(task.session_id);
    return row?.agent_session_id ?? null;
  }

  // ---- preflight -----------------------------------------------

  async preflight(taskId: string, direction: TeleportDirection): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const task = this.loadTask(taskId);

    if (task.kind === 'general') {
      checks.push({
        name: 'kind',
        status: 'fail',
        message: 'General tasks have no repo to teleport.',
      });
      return checks;
    }

    const currentLocation: TaskLocation = task.location === 'remote' ? 'remote' : 'local';
    if (currentLocation !== sourceLocation(direction)) {
      checks.push({
        name: 'location',
        status: 'fail',
        message: `Task is already ${currentLocation}; nothing to teleport in that direction.`,
      });
      return checks;
    }

    if (this.branchCount(taskId) > 1) {
      checks.push({
        name: 'branches',
        status: 'fail',
        message: 'Cards spanning more than one repo or branch are not supported yet.',
      });
      return checks;
    }

    if (this.sessions.getSession(taskId, 'secondary')) {
      checks.push({
        name: 'dual-session',
        status: 'fail',
        message: 'End the secondary session before teleporting.',
      });
      return checks;
    }

    // Without its own worktree, the task's "checkout" is the bare repo other
    // sessions may share — there is no single branch state that is safely
    // "this task's work" to stage, commit, and push.
    if (!task.worktree_path) {
      checks.push({
        name: 'worktree',
        status: 'fail',
        message: 'Task has no isolated worktree yet — open a session first so it gets one.',
      });
      return checks;
    }

    const repo = this.loadRepo(task.repo_id ?? '');
    if (direction === 'local-to-remote' && !repo.remote_path?.trim()) {
      checks.push({
        name: 'remote-path',
        status: 'fail',
        message: `Repo "${repo.label}" has no remote path configured.`,
      });
      return checks;
    }

    const dest = destLocation(direction);
    if (dest === 'remote') {
      if (!this.transports.hasRemote) {
        checks.push({
          name: 'remote-config',
          status: 'fail',
          message: 'No remote host configured.',
        });
        return checks;
      }

      const provider = createRemoteProvider(this.remote);
      if (provider) {
        const status = await provider.status();
        if (status === 'stopped' || status === 'failed') {
          checks.push({
            name: 'remote:workspace',
            status: 'fail',
            message: `${provider.label} is ${status}. Start it before teleporting.`,
            remediation: `coder start ${provider.label}`,
          });
        }
      }

      const remote = this.transports.getRemote();
      if ((await remote.reachability()) !== 'ok') {
        checks.push({
          name: 'remote:ssh',
          status: 'fail',
          message: `Cannot reach ${remote.host}.`,
          remediation: `Check your VPN, then verify: ssh ${remote.host} true`,
        });
        return checks;
      }
      checks.push({ name: 'remote:ssh', status: 'pass', message: `Connected to ${remote.host}` });

      const toolCheck = await this.checkTools(remote);
      checks.push(toolCheck);

      if (!(await remote.exists(`${repo.remote_path}/.git`))) {
        checks.push({
          name: 'remote:repo',
          status: 'fail',
          message: `Not a git repo on the remote host: ${repo.remote_path}`,
        });
      } else {
        checks.push({ name: 'remote:repo', status: 'pass', message: `${repo.remote_path} OK` });
      }
    }

    return checks;
  }

  private async checkTools(transport: ExecTransport): Promise<DoctorCheck> {
    const required = ['tmux', 'git', 'claude'];
    try {
      const { stdout } = await transport.exec([
        'sh',
        '-c',
        required.map((tool) => `command -v ${tool} >/dev/null 2>&1 && echo ${tool}`).join('; '),
      ]);
      const found = new Set(stdout.split('\n').map((line) => line.trim()));
      const missing = required.filter((tool) => !found.has(tool));
      if (missing.length > 0) {
        return {
          name: 'remote:tools',
          status: 'fail',
          message: `Missing on the remote host: ${missing.join(', ')}`,
        };
      }
      return { name: 'remote:tools', status: 'pass', message: `Found: ${required.join(', ')}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { name: 'remote:tools', status: 'fail', message: `Tool probe failed: ${message}` };
    }
  }

  // ---- run -------------------------------------------------------

  async run(taskId: string, direction: TeleportDirection): Promise<TeleportResult> {
    const checks = await this.preflight(taskId, direction);
    if (checks.some((c) => c.status === 'fail')) {
      throw new TeleportBlockedError(checks);
    }

    const task = this.loadTask(taskId);
    const repo = this.loadRepo(task.repo_id ?? '');
    const branch = this.branchName(task);
    const source = sourceLocation(direction);
    const dest = destLocation(direction);

    const sourceGit = this.gitFor(source);
    const sourceRepoPath = source === 'local' ? repo.path : repo.remote_path!;
    const sourceCwd = this.sourceCwd(task, repo, source);

    // Git operations that read or change the working tree run against
    // sourceCwd — the worktree, when the task has one, since that is where
    // the uncommitted work actually lives. sourceRepoPath is only the `-C`
    // anchor for operations that are repo-wide (worktree add/remove).
    const previousHead = await sourceGit.currentHead(sourceCwd);
    const previousWorktreePath = task.worktree_path;
    const branchId = this.db
      .prepare<[string], { id: string }>('SELECT id FROM task_branches WHERE task_id = ?')
      .get(taskId)?.id;
    let wipSha: string | null = null;
    let pushed = false;
    let locationFlipped = false;

    try {
      // 1. Stage + commit whatever is uncommitted, secrets excluded.
      wipSha = await sourceGit.stageAndCommitWip(sourceCwd, `[teleport wip] ${task.title}`);

      // 2. Push (force: this is a task-scoped branch, single owner).
      await sourceGit.pushCurrentBranch(sourceCwd, branch, 'origin', true, true);
      pushed = true;

      // 3. Flip location so worktree/session machinery resolves the new host.
      //    Nothing observes this until recreateSession runs below — the old
      //    session, still linked to its old backend row, keeps running.
      this.board.setTaskLocation(taskId, dest);
      locationFlipped = true;

      // 3b. Clear the stale worktree path before recomputing one: without this,
      //     WorktreeService reuses the *source* host's path verbatim (it treats
      //     a set worktree_path as "already resolved" and never re-derives it
      //     from the destination repo's own root), landing the destination
      //     worktree at a path that made sense on the other host, not this one.
      this.board.setTaskWorktree(taskId, null);
      if (branchId) {
        this.board.setTaskBranchWorktree(branchId, null);
      }

      // 4. Create the destination worktree, reusing the pushed branch.
      const destWorkspace = await this.worktrees.prepareTaskWorkspace(taskId);

      // 5. Copy the conversation transcript, if one exists yet. destWorkspace.path,
      //    not a recomputed one: `task` was loaded before the flip above, and its
      //    worktree_path is now stale — this call is the source of truth.
      const transcriptCopied = await this.copyTranscript(
        task,
        source,
        dest,
        sourceCwd,
        destWorkspace.path
      );

      // 6. Cut over: kill the old session, start a new one on the new host.
      //    The bootstrap script resumes by agent_session_id once it finds the
      //    transcript this just landed.
      const session = await this.sessions.recreateSession(taskId, 'primary');

      // 7. Prune the source worktree now that the destination is live.
      await this.pruneSourceWorktree(sourceGit, sourceRepoPath, sourceCwd);

      return { checks, session, wipCommitted: wipSha !== null, transcriptCopied };
    } catch (error) {
      await this.rollback({
        sourceGit,
        sourceCwd,
        branch,
        previousHead,
        previousWorktreePath,
        branchId,
        pushed,
        locationFlipped,
        taskId,
        source,
      });
      throw error;
    }
  }

  private async copyTranscript(
    task: TaskRow,
    source: TaskLocation,
    dest: TaskLocation,
    sourceCwd: string,
    destCwd: string
  ): Promise<boolean> {
    const agentSessionId = this.agentSessionId(task);
    if (!agentSessionId) {
      return false;
    }

    const sourceTransport = this.transportFor(source);
    const sourceConfigDir = await this.resolveClaudeConfigDir(sourceTransport);
    const sourcePath = claudeTranscriptPath(sourceConfigDir, sourceCwd, agentSessionId);

    if (!(await sourceTransport.exists(sourcePath))) {
      // A card that was opened and abandoned has nothing written yet — the
      // destination starts fresh under the same id, same as a first open.
      return false;
    }

    const destTransport = this.transportFor(dest);
    const destConfigDir = await this.resolveClaudeConfigDir(destTransport);
    const destPath = claudeTranscriptPath(destConfigDir, destCwd, agentSessionId);

    const remote = this.transports.getRemote();
    if (dest === 'remote') {
      await remote.copyFileTo(sourcePath, destPath);
    } else {
      await remote.copyFileFrom(sourcePath, destPath);
    }
    return true;
  }

  private async pruneSourceWorktree(
    sourceGit: GitService,
    sourceRepoPath: string,
    sourceCwd: string
  ): Promise<void> {
    if (sourceCwd === sourceRepoPath) {
      // The task worked directly in the bare checkout; nothing to remove.
      return;
    }
    await sourceGit.removeWorktreeAsync(sourceRepoPath, sourceCwd).catch(() => {
      // Best-effort: the destination is already live and confirmed, so a
      // leftover source worktree is clutter, not a correctness problem.
    });
  }

  private async rollback(params: {
    sourceGit: GitService;
    sourceCwd: string;
    branch: string;
    previousHead: string;
    previousWorktreePath: string | null;
    branchId: string | undefined;
    pushed: boolean;
    locationFlipped: boolean;
    taskId: string;
    source: TaskLocation;
  }): Promise<void> {
    const {
      sourceGit,
      sourceCwd,
      branch,
      previousHead,
      previousWorktreePath,
      branchId,
      pushed,
      locationFlipped,
      taskId,
      source,
    } = params;

    // The source session was never touched, so the only things to unwind are
    // the WIP commit, the push, the location flip, and the worktree path that
    // flip's own destination-worktree step clears before recomputing it.
    await sourceGit.resetHard(sourceCwd, previousHead).catch(() => undefined);
    if (pushed) {
      await sourceGit
        .pushCurrentBranch(sourceCwd, branch, 'origin', false, true)
        .catch(() => undefined);
    }
    if (locationFlipped) {
      this.board.setTaskLocation(taskId, source);
      this.board.setTaskWorktree(taskId, previousWorktreePath);
      if (branchId) {
        this.board.setTaskBranchWorktree(branchId, previousWorktreePath);
      }
    }
  }
}
