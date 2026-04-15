import { realpathSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import type { Db } from '../db/index.js';
import { generateId } from '../db/index.js';
import type { RepoRecord, RepoHealth, AddRepoParams, PreferredIDE, WorktreeMode } from '../types/index.js';

// --------------- Row helper ----------------------------------

function rowToRepo(r: Record<string, unknown>): RepoRecord {
  const githubOwner = (r['github_owner'] as string | null) ?? undefined;
  const githubRepo = (r['github_repo'] as string | null) ?? undefined;
  const githubUrl =
    (r['github_url'] as string | null) ??
    (githubOwner && githubRepo ? `https://github.com/${githubOwner}/${githubRepo}` : null);
  return {
    id: r['id'] as string,
    label: r['label'] as string,
    path: r['path'] as string,
    githubOwner,
    githubRepo,
    githubUrl: githubUrl ?? undefined,
    defaultBaseBranch: (r['default_base_branch'] as string) ?? 'main',
    defaultPillarId: (r['default_pillar_id'] as string | null) ?? undefined,
    preferredIde: (r['preferred_ide'] as PreferredIDE | null) ?? undefined,
    ideCommand: (r['ide_command'] as string | null) ?? undefined,
    worktreeMode: (r['worktree_mode'] as WorktreeMode | null) ?? 'auto',
    worktreeRoot: (r['worktree_root'] as string | null) ?? undefined,
    health: (r['health'] as RepoHealth) ?? 'ok',
    createdAt: r['created_at'] as number,
    updatedAt: r['updated_at'] as number,
  };
}

// --------------- GitHub remote detection --------------------

function detectGithubRemote(
  repoPath: string,
): { githubOwner?: string; githubRepo?: string; githubUrl?: string } {
  try {
    const url = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // HTTPS: https://github.com/owner/repo(.git)?
    const httpsMatch = url.match(/https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
    if (httpsMatch) {
      return {
        githubOwner: httpsMatch[1],
        githubRepo: httpsMatch[2],
        githubUrl: `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`,
      };
    }

    // SSH: git@github.com:owner/repo(.git)?
    const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/);
    if (sshMatch) {
      return {
        githubOwner: sshMatch[1],
        githubRepo: sshMatch[2],
        githubUrl: `https://github.com/${sshMatch[1]}/${sshMatch[2]}`,
      };
    }
  } catch {
    // git command failed or not a git repo — silently ignore
  }

  return {};
}

function detectDefaultBaseBranch(repoPath: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return ref.replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

// --------------- WorkspaceService ---------------------------

export class WorkspaceService {
  constructor(private db: Db) {}

  listRepos(): RepoRecord[] {
    return this.db
      .prepare<[], Record<string, unknown>>('SELECT * FROM repos ORDER BY label')
      .all()
      .map(rowToRepo);
  }

  getRepo(id: string): RepoRecord | null {
    const row = this.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM repos WHERE id = ?')
      .get(id);
    return row ? rowToRepo(row) : null;
  }

  getRepoByPath(absolutePath: string): RepoRecord | null {
    const row = this.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM repos WHERE path = ?')
      .get(absolutePath);
    return row ? rowToRepo(row) : null;
  }

  addRepo(params: AddRepoParams): RepoRecord {
    // 1. Resolve real path
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(params.path);
    } catch {
      throw new Error(`Path does not exist: ${params.path}`);
    }

    // 2. Check the directory exists and contains a .git entry
    if (!existsSync(resolvedPath)) {
      throw new Error(`Directory does not exist: ${resolvedPath}`);
    }
    if (!existsSync(join(resolvedPath, '.git'))) {
      throw new Error(`Not a git repository (no .git found): ${resolvedPath}`);
    }

    // 3. Check for duplicate path
    const existing = this.getRepoByPath(resolvedPath);
    if (existing) {
      throw new Error(`Repository already registered: ${resolvedPath} (id: ${existing.id})`);
    }

    // 4. Derive label from basename if not provided
    const label = params.label?.trim() || basename(resolvedPath);

    // 5. Detect githubOwner / githubRepo from git remote
    const { githubOwner, githubRepo, githubUrl } = detectGithubRemote(resolvedPath);
    const defaultBaseBranch = detectDefaultBaseBranch(resolvedPath);

    // 6. Persist and return
    const id = generateId();
    const now = Date.now();

    this.db
      .prepare<unknown[], void>(
        `INSERT INTO repos
           (id, label, path, github_owner, github_repo,
            github_url, default_base_branch, default_pillar_id, preferred_ide,
            ide_command, worktree_mode, worktree_root, health, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'auto', NULL, 'ok', ?, ?)`,
      )
      .run(
        id,
        label,
        resolvedPath,
        githubOwner ?? null,
        githubRepo ?? null,
        githubUrl ?? null,
        defaultBaseBranch,
        now,
        now,
      );

    return this.getRepo(id)!;
  }

  updateRepo(
    id: string,
    patch: Partial<
      Pick<
        RepoRecord,
        | 'label'
        | 'githubOwner'
        | 'githubRepo'
        | 'githubUrl'
        | 'defaultBaseBranch'
        | 'defaultPillarId'
        | 'preferredIde'
        | 'ideCommand'
        | 'worktreeMode'
        | 'worktreeRoot'
      >
    >,
  ): RepoRecord {
    const existing = this.getRepo(id);
    if (!existing) {
      throw new Error(`Repo not found: ${id}`);
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (patch.label !== undefined) {
      setClauses.push('label = ?');
      values.push(patch.label);
    }
    if (patch.githubOwner !== undefined) {
      setClauses.push('github_owner = ?');
      values.push(patch.githubOwner);
    }
    if (patch.githubRepo !== undefined) {
      setClauses.push('github_repo = ?');
      values.push(patch.githubRepo);
    }
    if (patch.githubUrl !== undefined) {
      setClauses.push('github_url = ?');
      values.push(patch.githubUrl);
    }
    if (patch.defaultBaseBranch !== undefined) {
      const defaultBaseBranch = patch.defaultBaseBranch.trim();
      if (!defaultBaseBranch) {
        throw new Error('Default base branch cannot be empty');
      }
      setClauses.push('default_base_branch = ?');
      values.push(defaultBaseBranch);
    }
    if (patch.defaultPillarId !== undefined) {
      setClauses.push('default_pillar_id = ?');
      values.push(patch.defaultPillarId);
    }
    if (patch.preferredIde !== undefined) {
      setClauses.push('preferred_ide = ?');
      values.push(patch.preferredIde);
    }
    if (patch.ideCommand !== undefined) {
      setClauses.push('ide_command = ?');
      values.push(patch.ideCommand);
    }
    if (patch.worktreeMode !== undefined) {
      setClauses.push('worktree_mode = ?');
      values.push(patch.worktreeMode);
    }
    if (patch.worktreeRoot !== undefined) {
      setClauses.push('worktree_root = ?');
      values.push(patch.worktreeRoot);
    }

    if (setClauses.length === 0) {
      return existing;
    }

    setClauses.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.db
      .prepare<unknown[], void>(`UPDATE repos SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.getRepo(id)!;
  }

  removeRepo(id: string): void {
    this.db.prepare<[string], void>('DELETE FROM repos WHERE id = ?').run(id);
  }

  checkRepoHealth(id: string): RepoHealth {
    const repo = this.getRepo(id);
    if (!repo) throw new Error(`Repo not found: ${id}`);

    let health: RepoHealth;

    if (!existsSync(repo.path)) {
      health = 'missing';
    } else if (!existsSync(join(repo.path, '.git'))) {
      health = 'not-git';
    } else {
      health = 'ok';
    }

    this.db
      .prepare<[string, number, string], void>(
        'UPDATE repos SET health = ?, updated_at = ? WHERE id = ?',
      )
      .run(health, Date.now(), id);

    return health;
  }

  reconcileHealth(): void {
    const repos = this.listRepos();
    for (const repo of repos) {
      this.checkRepoHealth(repo.id);
    }
  }
}
