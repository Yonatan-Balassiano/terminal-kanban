import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { TaskLifecycleService } from '../src/services/task-lifecycle.js';
import { WorktreeService } from '../src/services/worktree.js';
import { ViewService } from '../src/services/view.js';
import { SyncService } from '../src/services/sync.js';
import { SessionManager } from '../src/services/session-manager.js';
import { buildSessionBootstrapEnv } from '../src/services/session-bootstrap.js';
import type { CreateSessionOpts } from '../src/types/index.js';

describe('general tasks', () => {
  let db: Db;
  let board: BoardService;
  let repoPath: string;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    repoPath = mkdtempSync(join(tmpdir(), 'agentboard-repo-'));
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('repo-1', 'Repo', repoPath, 'owner', 'repo', 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
    rmSync(repoPath, { recursive: true, force: true });
  });

  describe('BoardService.createTask', () => {
    it('creates a card with no repo, branch, or remote location', () => {
      const task = board.createTask({ title: 'Read the MCP spec', kind: 'general' });

      expect(task.kind).toBe('general');
      expect(task.repoId).toBeUndefined();
      expect(task.branchName).toBeUndefined();
      expect(task.location).toBe('local');
    });

    it('keeps a general task local even when remote is requested', () => {
      const task = board.createTask({
        title: 'Think about naming',
        kind: 'general',
        location: 'remote',
      });

      expect(task.location).toBe('local');
    });

    it('throws when a repo task is created without a repoId', () => {
      expect(() => board.createTask({ title: 'No repo given' })).toThrow(/repoId/);
    });

    it('still creates repo tasks with a branch', () => {
      const task = board.createTask({ title: 'Ship it', repoId: 'repo-1' });

      expect(task.kind).toBe('repo');
      expect(task.repoId).toBe('repo-1');
      expect(task.branchName).toBeTruthy();
    });
  });

  describe('BoardService.renameTask', () => {
    it('does not invent a branch when renaming a general task', () => {
      const task = board.createTask({ title: 'Original title', kind: 'general' });

      board.renameTask(task.id, 'New title');

      const renamed = board.getTask(task.id);
      expect(renamed?.title).toBe('New title');
      expect(renamed?.branchName).toBeUndefined();
    });

    it('renames the branch of a repo task as before', () => {
      const task = board.createTask({ title: 'Original title', repoId: 'repo-1' });

      board.renameTask(task.id, 'New title');

      expect(board.getTask(task.id)?.branchName).toContain('new-title');
    });
  });

  describe('WorktreeService.prepareTaskWorkspace', () => {
    it('opens a general task in the home directory without touching git', async () => {
      const task = board.createTask({ title: 'Just a session', kind: 'general' });
      const git = {
        createWorktreeAsync: vi.fn(),
        removeWorktreeAsync: vi.fn(),
      };
      const worktrees = new WorktreeService(db, board, git as never);

      const workspace = await worktrees.prepareTaskWorkspace(task.id);

      expect(workspace.path).toBe(homedir());
      expect(workspace.repoPath).toBe(homedir());
      expect(workspace.usedWorktree).toBe(false);
      expect(git.createWorktreeAsync).not.toHaveBeenCalled();
      expect(board.getTask(task.id)?.worktreePath).toBeUndefined();
      expect(board.getTask(task.id)?.branchName).toBeUndefined();
    });
  });

  describe('TaskLifecycleService', () => {
    it('deletes a general task without looking for a worktree', async () => {
      const task = board.createTask({ title: 'Throwaway', kind: 'general' });
      const git = { removeWorktreeAsync: vi.fn() };
      const lifecycle = new TaskLifecycleService(db, board, git as never, {
        terminateTaskSessions: vi.fn(),
      } as never);

      await lifecycle.deleteTask(task.id);

      expect(git.removeWorktreeAsync).not.toHaveBeenCalled();
      expect(board.getTask(task.id)).toBeNull();
    });

    it('archives a general task', async () => {
      const task = board.createTask({ title: 'Done thinking', kind: 'general' });
      const lifecycle = new TaskLifecycleService(db, board, { removeWorktreeAsync: vi.fn() } as never, {
        terminateTaskSessions: vi.fn(),
      } as never);

      await lifecycle.archiveTask(task.id);

      expect(board.getTask(task.id)?.archivedAt).toBeDefined();
    });
  });

  describe('board snapshot filtering', () => {
    it('excludes general tasks when a repo filter is active', () => {
      board.createTask({ title: 'General card', kind: 'general' });
      board.createTask({ title: 'Repo card', repoId: 'repo-1' });
      const view = new ViewService(board);

      const filtered = view.getBoardSnapshot(undefined, { repoIds: ['repo-1'] });
      const unfiltered = view.getBoardSnapshot();

      expect(filtered.tasks.map((task) => task.title)).toEqual(['Repo card']);
      expect(unfiltered.tasks.map((task) => task.title).sort()).toEqual(['General card', 'Repo card']);
    });
  });

  describe('SyncService', () => {
    it('refuses to create a pull request for a general task', async () => {
      const task = board.createTask({ title: 'No PR here', kind: 'general' });
      const sync = new SyncService(board, {} as never, {} as never, db);

      await expect(sync.createTaskPR(task.id)).rejects.toThrow(/no repo or branch/);
    });
  });

  describe('session bootstrap', () => {
    it('marks the session as general so the script skips checkout', () => {
      const settings = buildSessionBootstrapEnv({
        taskKind: 'general',
        repoPath: '',
        branch: '',
        agentCli: 'claude',
        cwd: '/Users/someone',
      });

      expect(settings).toContain('export AGENTBOARD_TASK_KIND=general\n');
      expect(settings).toContain('export AGENTBOARD_SESSION_CWD=/Users/someone\n');
    });

    it('runs the agent without any git command for a general session', () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'agentboard-bootstrap-'));
      try {
        const gitMarker = join(sandbox, 'git-was-called');
        writeFileSync(join(sandbox, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(gitMarker)}\n`);
        writeFileSync(join(sandbox, 'claude'), '#!/bin/sh\necho AGENT_STARTED\n');
        chmodSync(join(sandbox, 'git'), 0o755);
        chmodSync(join(sandbox, 'claude'), 0o755);

        const stdout = execFileSync('bash', ['scripts/session-bootstrap.sh'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${sandbox}:${process.env['PATH'] ?? ''}`,
            AGENTBOARD_TASK_KIND: 'general',
            AGENTBOARD_REPO_PATH: '',
            AGENTBOARD_TASK_BRANCH: '',
            AGENTBOARD_SESSION_CWD: sandbox,
            AGENTBOARD_AGENT: 'claude',
            AGENTBOARD_USES_WORKTREE: '0',
            AGENTBOARD_BOOTSTRAP_NOTICE: '',
            AGENTBOARD_AGENT_ARGS: '',
          },
        });

        expect(stdout).toContain('AGENT_STARTED');
        expect(existsSync(gitMarker)).toBe(false);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  describe('schema migration', () => {
    it('relaxes tasks.repo_id to nullable on an existing database', () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentboard-db-'));
      const dbPath = join(dir, 'agentboard.db');
      try {
        const legacy = openDb(dbPath);
        legacy
          .prepare(
            `INSERT INTO repos (id, label, path, default_base_branch, health, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run('repo-1', 'Repo', repoPath, 'main', 'ok', 1, 1);
        const legacyBoard = new BoardService(legacy);
        const kept = legacyBoard.createTask({ title: 'Survives migration', repoId: 'repo-1' });
        // Rewind to the pre-general shape so the migration has something to fix.
        legacy.exec('DROP TABLE tasks');
        legacy.exec(
          `CREATE TABLE tasks (
             id TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
             track_id TEXT NOT NULL,
             sort_key REAL NOT NULL DEFAULT 0,
             pr_state TEXT NOT NULL DEFAULT 'none',
             pr_draft INTEGER NOT NULL DEFAULT 0,
             ci_state TEXT NOT NULL DEFAULT 'none',
             review_state TEXT NOT NULL DEFAULT 'none',
             unresolved_thread_count INTEGER NOT NULL DEFAULT 0,
             git_state TEXT NOT NULL DEFAULT 'unknown',
             git_ahead_count INTEGER NOT NULL DEFAULT 0,
             git_behind_count INTEGER NOT NULL DEFAULT 0,
             has_untracked INTEGER NOT NULL DEFAULT 0,
             has_conflicts INTEGER NOT NULL DEFAULT 0,
             github_sync_status TEXT NOT NULL DEFAULT 'idle',
             ci_required_total INTEGER NOT NULL DEFAULT 0,
             ci_required_passed INTEGER NOT NULL DEFAULT 0,
             ci_required_failed INTEGER NOT NULL DEFAULT 0,
             ci_required_pending INTEGER NOT NULL DEFAULT 0,
             session_attention_needed INTEGER NOT NULL DEFAULT 0,
             agent_cli TEXT NOT NULL DEFAULT 'claude',
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
           )`
        );
        legacy
          .prepare(
            `INSERT INTO tasks (id, title, repo_id, track_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(kept.id, kept.title, 'repo-1', 'backlog', 1, 1);
        legacy.close();

        const migrated = openDb(dbPath);
        try {
          const migratedBoard = new BoardService(migrated);
          const general = migratedBoard.createTask({ title: 'General after migration', kind: 'general' });

          expect(general.repoId).toBeUndefined();
          expect(migratedBoard.getTask(kept.id)?.title).toBe('Survives migration');
          expect(
            migrated
              .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_repo'")
              .get()
          ).toBeDefined();
        } finally {
          migrated.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('SessionManager with a general task', () => {
  class FakeBackendSessionManager extends SessionManager {
    constructor(db: Db, board: BoardService, worktrees: unknown, private backend: unknown) {
      super(db, board, worktrees as never, {
        write() {},
        has: () => false,
        getBuffer: () => ({ lines: [], ansiLines: [], cursorX: 0, cursorY: 0 }),
        subscribeAll: () => () => {},
        destroy() {},
      } as never);
    }

    override getBackend(): never {
      return this.backend as never;
    }
  }

  let db: Db;
  let board: BoardService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('opens the session in the home directory with no repo path or branch', async () => {
    const task = board.createTask({ title: 'Plan the week', kind: 'general' });
    const create = vi.fn(async (opts: CreateSessionOpts) => ({
      id: 'session-1',
      taskId: opts.taskId,
      slot: opts.slot,
      backendType: 'tmux' as const,
      backendSessionId: 'ab_plan_the_week_p',
      attachCommand: 'tmux attach -t ab_plan_the_week_p',
      status: 'active' as const,
      cwd: opts.cwd ?? opts.repoPath,
      branch: opts.branch,
      createdAt: 1,
      updatedAt: 1,
    }));
    const backend = {
      create,
      attachMetadata: vi.fn(async (id: string) => ({ command: `tmux attach -t ${id}` })),
      sendInput: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      inspect: vi.fn(async () => null),
      terminate: vi.fn(async () => {}),
      healthCheck: vi.fn(async () => ({ available: true })),
    };
    const worktrees = new WorktreeService(db, board, { createWorktreeAsync: vi.fn() } as never);
    const manager = new FakeBackendSessionManager(db, board, worktrees, backend);

    const session = await manager.openSession(task.id);

    expect(create).toHaveBeenCalledTimes(1);
    const opts = create.mock.calls[0]![0];
    expect(opts.taskKind).toBe('general');
    expect(opts.repoPath).toBe('');
    expect(opts.branch).toBe('');
    expect(opts.cwd).toBe(homedir());
    expect(session.branch).toBeUndefined();
    expect(board.getTask(task.id)?.branchName).toBeUndefined();
    expect(board.getTask(task.id)?.trackId).toBe('in-progress');
  });
});
