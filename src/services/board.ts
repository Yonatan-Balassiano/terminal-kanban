import type { Db } from '../db/index.js';
import { generateId } from '../db/index.js';
import type {
  TaskRecord,
  PillarRecord,
  LabelRecord,
  SavedViewRecord,
  UIStateRecord,
  FilterModel,
  CreateTaskParams,
  CreatePillarParams,
  MoveTaskParams,
  PRState,
  CIState,
  ReviewState,
  GitHubSyncStatus,
  ThemeMode,
  GitState,
  TaskSyncPatch,
} from '../types/index.js';
import { createTaskBranchName, renameTaskBranchName } from './branch-name.js';

// --------------- Row helpers ----------------------------------

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: row['id'] as string,
    title: row['title'] as string,
    description: (row['description'] as string | null) ?? undefined,
    repoId: row['repo_id'] as string,
    agentCli: (row['agent_cli'] as 'claude' | 'codex' | null) ?? 'claude',
    trackId: row['track_id'] as string,
    pillarId: (row['pillar_id'] as string | null) ?? undefined,
    labels: [],
    branchName: (row['branch_name'] as string | null) ?? undefined,
    worktreePath: (row['worktree_path'] as string | null) ?? undefined,
    sessionId: (row['session_id'] as string | null) ?? undefined,
    lastSessionCwd: (row['last_session_cwd'] as string | null) ?? undefined,
    sortKey: row['sort_key'] as number,
    prNumber: (row['pr_number'] as number | null) ?? undefined,
    prState: (row['pr_state'] as PRState) ?? 'none',
    prDraft: row['pr_draft'] === 1 || row['pr_draft'] === true,
    prUrl: (row['pr_url'] as string | null) ?? undefined,
    ciState: (row['ci_state'] as CIState) ?? 'none',
    ciSummary: (row['ci_summary'] as string | null) ?? undefined,
    failingCheckName: (row['failing_check_name'] as string | null) ?? undefined,
    ciRequiredTotal: (row['ci_required_total'] as number | null) ?? 0,
    ciRequiredPassed: (row['ci_required_passed'] as number | null) ?? 0,
    ciRequiredFailed: (row['ci_required_failed'] as number | null) ?? 0,
    ciRequiredPending: (row['ci_required_pending'] as number | null) ?? 0,
    reviewState: (row['review_state'] as ReviewState) ?? 'none',
    reviewSummary: (row['review_summary'] as string | null) ?? undefined,
    unresolvedThreadCount: (row['unresolved_thread_count'] as number) ?? 0,
    githubSyncStatus: (row['github_sync_status'] as GitHubSyncStatus | null) ?? 'idle',
    githubSyncError: (row['github_sync_error'] as string | null) ?? undefined,
    githubLastSyncedAt: (row['github_last_synced_at'] as number | null) ?? undefined,
    gitState: (row['git_state'] as GitState | null) ?? 'unknown',
    gitAheadCount: (row['git_ahead_count'] as number | null) ?? 0,
    gitBehindCount: (row['git_behind_count'] as number | null) ?? 0,
    hasUntracked: row['has_untracked'] === 1 || row['has_untracked'] === true,
    hasConflicts: row['has_conflicts'] === 1 || row['has_conflicts'] === true,
    sessionAttentionNeeded:
      row['session_attention_needed'] === 1 || row['session_attention_needed'] === true,
    sessionAttentionUpdatedAt:
      (row['session_attention_updated_at'] as number | null) ?? undefined,
    archivedAt: (row['archived_at'] as number | null) ?? undefined,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
  };
}

// --------------- BoardService --------------------------------

export class BoardService {
  constructor(private db: Db) {}

  // ---- Task methods ------------------------------------------

  getTasks(filter?: { repoId?: string; includeArchived?: boolean }): TaskRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.repoId) {
      conditions.push('t.repo_id = ?');
      params.push(filter.repoId);
    }

    if (!filter?.includeArchived) {
      conditions.push('t.archived_at IS NULL');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = this.db
      .prepare<unknown[], Record<string, unknown>>(
        `SELECT t.* FROM tasks t ${where} ORDER BY t.track_id, t.sort_key`,
      )
      .all(...params);

    const tasks = rows.map((r) => rowToTask(r));

    if (tasks.length === 0) return tasks;

    // Bulk-load labels for the returned task ids
    const ids = tasks.map((t) => t.id);
    const placeholders = ids.map(() => '?').join(',');
    const labelRows = this.db
      .prepare<unknown[], { task_id: string; label_id: string }>(
        `SELECT task_id, label_id FROM task_labels WHERE task_id IN (${placeholders})`,
      )
      .all(...ids);

    const labelMap = new Map<string, string[]>();
    for (const lr of labelRows) {
      const arr = labelMap.get(lr.task_id) ?? [];
      arr.push(lr.label_id);
      labelMap.set(lr.task_id, arr);
    }

    for (const task of tasks) {
      task.labels = labelMap.get(task.id) ?? [];
    }

    return tasks;
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?')
      .get(id);

    if (!row) return null;

    const task = rowToTask(row);

    const labelRows = this.db
      .prepare<[string], { label_id: string }>(
        'SELECT label_id FROM task_labels WHERE task_id = ?',
      )
      .all(id);

    task.labels = labelRows.map((l) => l.label_id);
    return task;
  }

  createTask(params: CreateTaskParams): TaskRecord {
    const id = generateId();
    const now = Date.now();
    const trackId = params.trackId ?? 'backlog';
    const branchName = createTaskBranchName(params.title);
    const agentCli = params.agentCli ?? 'claude';

    // Compute next sortKey = max existing + 1000 (or 1000 if track is empty)
    const maxRow = this.db
      .prepare<[string], { max_key: number | null }>(
        'SELECT MAX(sort_key) AS max_key FROM tasks WHERE track_id = ?',
      )
      .get(trackId);
    const sortKey = (maxRow?.max_key ?? 0) + 1000;

    this.db
      .prepare<unknown[], void>(
        `INSERT INTO tasks
           (id, title, repo_id, agent_cli, track_id, pillar_id, branch_name, sort_key,
            pr_state, pr_draft, ci_state, review_state, unresolved_thread_count,
            github_sync_status, ci_required_total, ci_required_passed, ci_required_failed,
            ci_required_pending, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', 0, 'none', 'none', 0, 'idle', 0, 0, 0, 0, ?, ?)`,
      )
      .run(
        id,
        params.title,
        params.repoId,
        agentCli,
        trackId,
        params.pillarId ?? null,
        branchName,
        sortKey,
        now,
        now,
      );

    return this.getTask(id)!;
  }

  renameTask(id: string, title: string): void {
    const current = this.db
      .prepare<[string], { branch_name: string | null; session_id: string | null }>(
        'SELECT branch_name, session_id FROM tasks WHERE id = ?',
      )
      .get(id);

    if (current && current.session_id == null) {
      this.db
        .prepare<[string, string, number, string], void>(
          'UPDATE tasks SET title = ?, branch_name = ?, updated_at = ? WHERE id = ?',
        )
        .run(title, renameTaskBranchName(title, current.branch_name ?? undefined), Date.now(), id);
      return;
    }

    this.db
      .prepare<[string, number, string], void>(
        'UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?',
      )
      .run(title, Date.now(), id);
  }

  setTaskDescription(id: string, description: string): void {
    const nextDescription = description.length > 0 ? description : null;
    this.db
      .prepare<[string | null, number, string], void>(
        'UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?',
      )
      .run(nextDescription, Date.now(), id);
  }

  moveTask(params: MoveTaskParams): void {
    const now = Date.now();
    if (params.sortKey !== undefined) {
      this.db
        .prepare<[string, number, number, string], void>(
          'UPDATE tasks SET track_id = ?, sort_key = ?, updated_at = ? WHERE id = ?',
        )
        .run(params.trackId, params.sortKey, now, params.id);
    } else {
      // Compute next sortKey for the destination track
      const maxRow = this.db
        .prepare<[string], { max_key: number | null }>(
          'SELECT MAX(sort_key) AS max_key FROM tasks WHERE track_id = ?',
        )
        .get(params.trackId);
      const sortKey = (maxRow?.max_key ?? 0) + 1000;

      this.db
        .prepare<[string, number, number, string], void>(
          'UPDATE tasks SET track_id = ?, sort_key = ?, updated_at = ? WHERE id = ?',
        )
        .run(params.trackId, sortKey, now, params.id);
    }
  }

  reorderTask(id: string, sortKey: number): void {
    this.db
      .prepare<[number, number, string], void>(
        'UPDATE tasks SET sort_key = ?, updated_at = ? WHERE id = ?',
      )
      .run(sortKey, Date.now(), id);
  }

  assignPillar(id: string, pillarId: string | null): void {
    this.db
      .prepare<[string | null, number, string], void>(
        'UPDATE tasks SET pillar_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(pillarId, Date.now(), id);
  }

  setLabels(id: string, labelIds: string[]): void {
    const del = this.db.prepare<[string], void>('DELETE FROM task_labels WHERE task_id = ?');
    const ins = this.db.prepare<[string, string], void>(
      'INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)',
    );

    const apply = this.db.transaction(() => {
      del.run(id);
      for (const labelId of labelIds) {
        ins.run(id, labelId);
      }
      this.db
        .prepare<[number, string], void>('UPDATE tasks SET updated_at = ? WHERE id = ?')
        .run(Date.now(), id);
    });

    apply();
  }

  archiveTask(id: string): void {
    const now = Date.now();
    this.db
      .prepare<[number, number, string], void>(
        'UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(now, now, id);
  }

  deleteTask(id: string): void {
    this.db.prepare<[string], void>('DELETE FROM tasks WHERE id = ?').run(id);
  }

  updateTaskSync(
    id: string,
    fields: TaskSyncPatch,
  ): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    const has = (key: keyof TaskSyncPatch): boolean =>
      Object.prototype.hasOwnProperty.call(fields, key);

    if (has('prNumber')) {
      setClauses.push('pr_number = ?');
      values.push(fields.prNumber ?? null);
    }
    if (has('prState') && fields.prState !== undefined) {
      setClauses.push('pr_state = ?');
      values.push(fields.prState);
    }
    if (has('prDraft') && fields.prDraft !== undefined) {
      setClauses.push('pr_draft = ?');
      values.push(fields.prDraft ? 1 : 0);
    }
    if (has('prUrl')) {
      setClauses.push('pr_url = ?');
      values.push(fields.prUrl ?? null);
    }
    if (has('ciState') && fields.ciState !== undefined) {
      setClauses.push('ci_state = ?');
      values.push(fields.ciState);
    }
    if (has('ciSummary')) {
      setClauses.push('ci_summary = ?');
      values.push(fields.ciSummary ?? null);
    }
    if (has('failingCheckName')) {
      setClauses.push('failing_check_name = ?');
      values.push(fields.failingCheckName ?? null);
    }
    if (has('ciRequiredTotal') && fields.ciRequiredTotal !== undefined) {
      setClauses.push('ci_required_total = ?');
      values.push(fields.ciRequiredTotal);
    }
    if (has('ciRequiredPassed') && fields.ciRequiredPassed !== undefined) {
      setClauses.push('ci_required_passed = ?');
      values.push(fields.ciRequiredPassed);
    }
    if (has('ciRequiredFailed') && fields.ciRequiredFailed !== undefined) {
      setClauses.push('ci_required_failed = ?');
      values.push(fields.ciRequiredFailed);
    }
    if (has('ciRequiredPending') && fields.ciRequiredPending !== undefined) {
      setClauses.push('ci_required_pending = ?');
      values.push(fields.ciRequiredPending);
    }
    if (has('reviewState') && fields.reviewState !== undefined) {
      setClauses.push('review_state = ?');
      values.push(fields.reviewState);
    }
    if (has('reviewSummary')) {
      setClauses.push('review_summary = ?');
      values.push(fields.reviewSummary ?? null);
    }
    if (has('unresolvedThreadCount') && fields.unresolvedThreadCount !== undefined) {
      setClauses.push('unresolved_thread_count = ?');
      values.push(fields.unresolvedThreadCount);
    }
    if (has('githubSyncStatus') && fields.githubSyncStatus !== undefined) {
      setClauses.push('github_sync_status = ?');
      values.push(fields.githubSyncStatus);
    }
    if (has('githubSyncError')) {
      setClauses.push('github_sync_error = ?');
      values.push(fields.githubSyncError ?? null);
    }
    if (has('githubLastSyncedAt')) {
      setClauses.push('github_last_synced_at = ?');
      values.push(fields.githubLastSyncedAt ?? null);
    }
    if (has('gitState') && fields.gitState !== undefined) {
      setClauses.push('git_state = ?');
      values.push(fields.gitState);
    }
    if (has('gitAheadCount') && fields.gitAheadCount !== undefined) {
      setClauses.push('git_ahead_count = ?');
      values.push(fields.gitAheadCount);
    }
    if (has('gitBehindCount') && fields.gitBehindCount !== undefined) {
      setClauses.push('git_behind_count = ?');
      values.push(fields.gitBehindCount);
    }
    if (has('hasUntracked') && fields.hasUntracked !== undefined) {
      setClauses.push('has_untracked = ?');
      values.push(fields.hasUntracked ? 1 : 0);
    }
    if (has('hasConflicts') && fields.hasConflicts !== undefined) {
      setClauses.push('has_conflicts = ?');
      values.push(fields.hasConflicts ? 1 : 0);
    }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.db
      .prepare<unknown[], void>(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  linkSession(taskId: string, sessionId: string): void {
    this.db
      .prepare<[string, number, string], void>(
        'UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(sessionId, Date.now(), taskId);
  }

  setTaskBranch(taskId: string, branchName: string): void {
    this.db
      .prepare<[string, number, string], void>(
        'UPDATE tasks SET branch_name = ?, updated_at = ? WHERE id = ?',
      )
      .run(branchName, Date.now(), taskId);
  }

  setTaskWorktree(taskId: string, worktreePath: string | null): void {
    this.db
      .prepare<[string | null, number, string], void>(
        'UPDATE tasks SET worktree_path = ?, updated_at = ? WHERE id = ?',
      )
      .run(worktreePath, Date.now(), taskId);
  }

  setTaskLastSessionCwd(taskId: string, cwd: string | null): void {
    this.db
      .prepare<[string | null, number, string], void>(
        'UPDATE tasks SET last_session_cwd = ?, updated_at = ? WHERE id = ?',
      )
      .run(cwd, Date.now(), taskId);
  }

  setTaskSessionAttention(taskId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare<[number, number, number, string]>(
        `UPDATE tasks
         SET session_attention_needed = ?,
             session_attention_updated_at = ?,
             updated_at = ?
         WHERE id = ?
           AND session_attention_needed = 0`,
      )
      .run(1, now, now, taskId);
    return result.changes > 0;
  }

  clearTaskSessionAttention(taskId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare<[number, string]>(
        `UPDATE tasks
         SET session_attention_needed = 0,
             session_attention_updated_at = NULL,
             updated_at = ?
         WHERE id = ?
           AND session_attention_needed = 1`,
      )
      .run(now, taskId);
    return result.changes > 0;
  }

  // ---- Track methods -----------------------------------------

  upsertTrack(id: string, label: string, sortOrder: number): void {
    this.db
      .prepare<[string, string, number], void>(
        `INSERT INTO tracks (id, label, sort_order) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, sort_order = excluded.sort_order`,
      )
      .run(id, label, sortOrder);
  }

  deleteTrack(id: string): void {
    this.db.prepare<[string], void>('DELETE FROM tracks WHERE id = ?').run(id);
  }

  // ---- Pillar methods ----------------------------------------

  getPillars(): PillarRecord[] {
    return this.db
      .prepare<[], Record<string, unknown>>('SELECT * FROM pillars ORDER BY label')
      .all()
      .map((r) => ({
        id: r['id'] as string,
        label: r['label'] as string,
        icon: (r['icon'] as string | null) ?? undefined,
        color: (r['color'] as string | null) ?? undefined,
      }));
  }

  upsertPillar(p: PillarRecord): void {
    this.db
      .prepare<[string, string, string | null, string | null], void>(
        `INSERT INTO pillars (id, label, icon, color)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, icon = excluded.icon, color = excluded.color`,
      )
      .run(p.id, p.label, p.icon ?? null, p.color ?? null);
  }

  createPillar(params: CreatePillarParams): PillarRecord {
    const pillar: PillarRecord = {
      id: generateId(),
      label: params.label.trim(),
    };

    this.upsertPillar(pillar);
    return pillar;
  }

  deletePillar(id: string): void {
    const apply = this.db.transaction(() => {
      this.db
        .prepare<[string], void>('DELETE FROM tasks WHERE pillar_id = ?')
        .run(id);
      this.db
        .prepare<[string], void>('UPDATE repos SET default_pillar_id = NULL WHERE default_pillar_id = ?')
        .run(id);
      this.db.prepare<[string], void>('DELETE FROM pillars WHERE id = ?').run(id);
    });

    apply();
  }

  // ---- Label methods -----------------------------------------

  getLabels(): LabelRecord[] {
    return this.db
      .prepare<[], Record<string, unknown>>('SELECT * FROM labels ORDER BY label')
      .all()
      .map((r) => ({
        id: r['id'] as string,
        label: r['label'] as string,
        color: (r['color'] as string | null) ?? undefined,
      }));
  }

  upsertLabel(l: LabelRecord): void {
    this.db
      .prepare<[string, string, string | null], void>(
        `INSERT INTO labels (id, label, color)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, color = excluded.color`,
      )
      .run(l.id, l.label, l.color ?? null);
  }

  deleteLabel(id: string): void {
    this.db.prepare<[string], void>('DELETE FROM labels WHERE id = ?').run(id);
  }

  // ---- Saved view methods ------------------------------------

  getSavedViews(): SavedViewRecord[] {
    return this.db
      .prepare<[], Record<string, unknown>>('SELECT * FROM saved_views ORDER BY label')
      .all()
      .map((r) => ({
        id: r['id'] as string,
        label: r['label'] as string,
        filters: JSON.parse(r['filters_json'] as string) as FilterModel,
        isSystem: r['is_system'] === 1 || r['is_system'] === true,
        createdAt: r['created_at'] as number,
      }));
  }

  upsertSavedView(v: SavedViewRecord): void {
    this.db
      .prepare<[string, string, string, number, number], void>(
        `INSERT INTO saved_views (id, label, filters_json, is_system, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, filters_json = excluded.filters_json`,
      )
      .run(v.id, v.label, JSON.stringify(v.filters), v.isSystem ? 1 : 0, v.createdAt);
  }

  deleteSavedView(id: string): void {
    this.db.prepare<[string], void>('DELETE FROM saved_views WHERE id = ?').run(id);
  }

  // ---- UI state ----------------------------------------------

  getUIState(): UIStateRecord {
    const rows = this.db
      .prepare<[], { key: string; value_json: string }>('SELECT key, value_json FROM ui_state')
      .all();

    const map = new Map<string, unknown>();
    for (const row of rows) {
      map.set(row.key, JSON.parse(row.value_json));
    }

    const state: UIStateRecord = {};

    if (map.has('activeRepoId')) state.activeRepoId = map.get('activeRepoId') as string;
    if (map.has('activeViewId')) state.activeViewId = map.get('activeViewId') as string;
    if (map.has('filters')) state.filters = map.get('filters') as FilterModel;
    if (map.has('selectedTrackId')) state.selectedTrackId = map.get('selectedTrackId') as string;
    if (map.has('selectedTaskId')) state.selectedTaskId = map.get('selectedTaskId') as string;
    if (map.has('terminalPaneVisible'))
      state.terminalPaneVisible = map.get('terminalPaneVisible') as boolean;
    if (map.has('terminalLayoutMode'))
      state.terminalLayoutMode = map.get('terminalLayoutMode') as import('../types/index.js').TerminalLayoutMode;
    if (map.has('themeMode')) state.themeMode = map.get('themeMode') as ThemeMode;

    return state;
  }

  setUIState(patch: Partial<UIStateRecord>): void {
    const stmt = this.db.prepare<[string, string], void>(
      `INSERT INTO ui_state (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    );

    const apply = this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
          stmt.run(key, JSON.stringify(value));
        }
      }
    });

    apply();
  }
}
