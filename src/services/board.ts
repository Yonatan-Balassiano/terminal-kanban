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
  TaskKind,
  TaskLocation,
  TaskSyncPatch,
  TaskBranchRecord,
  TaskBranchSyncPatch,
} from '../types/index.js';
import { createTaskBranchName, renameTaskBranchName } from './branch-name.js';
import { rollupBranches, rowToTaskBranch } from './task-branches.js';

// --------------- Row helpers ----------------------------------

/**
 * Builds the SET clauses shared by a card and one of its branches.
 *
 * The two tables carry the same GitHub columns by design — a card's are the
 * rollup of its branches' — so the patch shape and the SQL are shared rather
 * than written twice and left to drift.
 */
function buildSyncClauses(fields: TaskSyncPatch): {
  setClauses: string[];
  values: unknown[];
} {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  const has = (key: keyof TaskSyncPatch): boolean =>
    Object.prototype.hasOwnProperty.call(fields, key);

  /** Nullable columns: an explicitly absent value clears them. */
  const nullable: Array<[keyof TaskSyncPatch, string]> = [
    ['prNumber', 'pr_number'],
    ['prUrl', 'pr_url'],
    ['ciSummary', 'ci_summary'],
    ['failingCheckName', 'failing_check_name'],
    ['reviewSummary', 'review_summary'],
    ['githubSyncError', 'github_sync_error'],
    ['githubLastSyncedAt', 'github_last_synced_at'],
  ];
  for (const [key, column] of nullable) {
    if (has(key)) {
      setClauses.push(`${column} = ?`);
      values.push(fields[key] ?? null);
    }
  }

  /** Non-null columns: only written when the patch carries a value. */
  const required: Array<[keyof TaskSyncPatch, string]> = [
    ['prState', 'pr_state'],
    ['ciState', 'ci_state'],
    ['ciRequiredTotal', 'ci_required_total'],
    ['ciRequiredPassed', 'ci_required_passed'],
    ['ciRequiredFailed', 'ci_required_failed'],
    ['ciRequiredPending', 'ci_required_pending'],
    ['reviewState', 'review_state'],
    ['unresolvedThreadCount', 'unresolved_thread_count'],
    ['githubSyncStatus', 'github_sync_status'],
    ['gitState', 'git_state'],
    ['gitAheadCount', 'git_ahead_count'],
    ['gitBehindCount', 'git_behind_count'],
  ];
  for (const [key, column] of required) {
    if (has(key) && fields[key] !== undefined) {
      setClauses.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }

  const booleans: Array<[keyof TaskSyncPatch, string]> = [
    ['prDraft', 'pr_draft'],
    ['hasUntracked', 'has_untracked'],
    ['hasConflicts', 'has_conflicts'],
  ];
  for (const [key, column] of booleans) {
    if (has(key) && fields[key] !== undefined) {
      setClauses.push(`${column} = ?`);
      values.push(fields[key] ? 1 : 0);
    }
  }

  return { setClauses, values };
}

/** Blank text and "no text at all" are the same thing to a nullable column. */
function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: row['id'] as string,
    title: row['title'] as string,
    description: (row['description'] as string | null) ?? undefined,
    initialPrompt: (row['initial_prompt'] as string | null) ?? undefined,
    kind: (row['kind'] as TaskKind | null) ?? 'repo',
    parentTaskId: (row['parent_task_id'] as string | null) ?? undefined,
    childPrAlertTaskId: (row['child_pr_alert_task_id'] as string | null) ?? undefined,
    isOrchestrator: row['is_orchestrator'] === 1 || row['is_orchestrator'] === true,
    sessionName: (row['session_name'] as string | null) ?? undefined,
    repoId: (row['repo_id'] as string | null) ?? undefined,
    agentCli: (row['agent_cli'] as 'claude' | 'codex' | null) ?? 'claude',
    location: (row['location'] as TaskLocation | null) ?? 'local',
    trackId: row['track_id'] as string,
    pillarId: (row['pillar_id'] as string | null) ?? undefined,
    labels: [],
    branchName: (row['branch_name'] as string | null) ?? undefined,
    worktreePath: (row['worktree_path'] as string | null) ?? undefined,
    sessionId: (row['session_id'] as string | null) ?? undefined,
    secondarySessionId: (row['secondary_session_id'] as string | null) ?? undefined,
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
    // Filled in by the bulk load; a task read on its own reports no branches
    // rather than silently querying per row.
    branches: [],
    activeBranchId: (row['active_branch_id'] as string | null) ?? undefined,
    prCount: (row['pr_count'] as number | null) ?? 0,
    prOpenCount: (row['pr_open_count'] as number | null) ?? 0,
    prMergedCount: (row['pr_merged_count'] as number | null) ?? 0,
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
        `SELECT t.*
         FROM tasks t
         ${where}
         ORDER BY t.track_id, t.sort_key`,
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

    // Bulk-loaded for the same reason labels are: this runs on nearly every
    // RPC, and a query per card would make it N+1 on every keystroke.
    const branchRows = this.db
      .prepare<unknown[], Record<string, unknown>>(
        `SELECT * FROM task_branches WHERE task_id IN (${placeholders}) ORDER BY sort_key`,
      )
      .all(...ids);

    const branchMap = new Map<string, TaskBranchRecord[]>();
    for (const row of branchRows) {
      const branch = rowToTaskBranch(row);
      const arr = branchMap.get(branch.taskId) ?? [];
      arr.push(branch);
      branchMap.set(branch.taskId, arr);
    }

    for (const task of tasks) {
      task.labels = labelMap.get(task.id) ?? [];
      task.branches = branchMap.get(task.id) ?? [];
    }

    return tasks;
  }

  // ---- Branch methods ----------------------------------------

  /** Every repo and branch a card is working in. */
  getTaskBranches(taskId: string): TaskBranchRecord[] {
    return this.db
      .prepare<[string], Record<string, unknown>>(
        'SELECT * FROM task_branches WHERE task_id = ? ORDER BY sort_key',
      )
      .all(taskId)
      .map(rowToTaskBranch);
  }

  /**
   * The id of whichever task already has this repo + branch attached, if any.
   *
   * Sync's cross-repo discovery (`discoverReferencingBranches`,
   * `discoverSiblingBranches`) finds candidate branches by GitHub search —
   * a shared parent's sibling subtasks routinely mention each other's PR
   * numbers in passing, which reads exactly like a genuine cross-repo
   * reference for the *same* piece of work. Callers must check this before
   * attaching a discovered branch, so a sibling's own PR never gets
   * relabeled as this task's.
   */
  findTaskBranchOwner(repoId: string, branchName: string): string | null {
    const row = this.db
      .prepare<[string, string], { task_id: string }>(
        'SELECT task_id FROM task_branches WHERE repo_id = ? AND branch_name = ? LIMIT 1',
      )
      .get(repoId, branchName);
    return row?.task_id ?? null;
  }

  /**
   * Adds a repo + branch to a card, or returns the existing one.
   *
   * Idempotent by (task, repo, branch) so a branch discovered again by sync
   * never becomes a duplicate.
   */
  addTaskBranch(params: {
    taskId: string;
    repoId: string;
    branchName: string;
    baseBranch?: string;
    worktreePath?: string;
  }): TaskBranchRecord {
    const existing = this.db
      .prepare<[string, string, string], Record<string, unknown>>(
        'SELECT * FROM task_branches WHERE task_id = ? AND repo_id = ? AND branch_name = ?',
      )
      .get(params.taskId, params.repoId, params.branchName);
    if (existing) {
      return rowToTaskBranch(existing);
    }

    const now = Date.now();
    const id = generateId();
    const nextSortKey =
      this.db
        .prepare<[string], { next: number }>(
          'SELECT COALESCE(MAX(sort_key), -1) + 1 AS next FROM task_branches WHERE task_id = ?',
        )
        .get(params.taskId)?.next ?? 0;

    this.db
      .prepare(
        `INSERT INTO task_branches
           (id, task_id, repo_id, branch_name, base_branch, worktree_path, sort_key,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.taskId,
        params.repoId,
        params.branchName,
        params.baseBranch ?? null,
        params.worktreePath ?? null,
        nextSortKey,
        now,
        now,
      );

    // The first branch a card gets is the one its session works in.
    this.db
      .prepare<[string, string], void>(
        'UPDATE tasks SET active_branch_id = COALESCE(active_branch_id, ?) WHERE id = ?',
      )
      .run(id, params.taskId);

    this.recomputeTaskRollup(params.taskId);
    return this.getTaskBranch(id)!;
  }

  getTaskBranch(branchId: string): TaskBranchRecord | null {
    const row = this.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM task_branches WHERE id = ?')
      .get(branchId);
    return row ? rowToTaskBranch(row) : null;
  }

  removeTaskBranch(branchId: string): void {
    const branch = this.getTaskBranch(branchId);
    if (!branch) {
      return;
    }

    this.db.prepare<[string], void>('DELETE FROM task_branches WHERE id = ?').run(branchId);

    // Hand the session to whatever is left rather than leaving it pointing at a
    // branch that no longer exists. Only touches the card that lost a branch,
    // and only when that branch was the active one.
    this.db
      .prepare<[string, string], void>(
        `UPDATE tasks
            SET active_branch_id =
                  (SELECT b.id FROM task_branches b WHERE b.task_id = tasks.id
                    ORDER BY b.sort_key LIMIT 1)
          WHERE id = ? AND active_branch_id = ?`,
      )
      .run(branch.taskId, branchId);

    this.recomputeTaskRollup(branch.taskId);
  }

  setTaskBranchWorktree(branchId: string, worktreePath: string | null): void {
    this.db
      .prepare<[string | null, number, string], void>(
        'UPDATE task_branches SET worktree_path = ?, updated_at = ? WHERE id = ?',
      )
      .run(worktreePath, Date.now(), branchId);
  }

  /**
   * Points the card's session at one of its branches.
   *
   * The branch's repo, name and worktree are mirrored onto the card because
   * session bootstrap and workspace planning still read them from there. The
   * repo has to move with them: leaving `repo_id` on the previous repository
   * would pair one repo's identity with another's branch, and the session would
   * be built from the wrong base branch and the wrong checkout.
   */
  setActiveTaskBranch(taskId: string, branchId: string): void {
    const branch = this.getTaskBranch(branchId);
    if (!branch || branch.taskId !== taskId) {
      throw new Error(`Branch ${branchId} does not belong to task ${taskId}`);
    }

    this.db
      .prepare<[string, string, string, string | null, number, string], void>(
        `UPDATE tasks
            SET active_branch_id = ?, repo_id = ?, branch_name = ?, worktree_path = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        branchId,
        branch.repoId,
        branch.branchName,
        branch.worktreePath ?? null,
        Date.now(),
        taskId,
      );
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
    task.branches = this.getTaskBranches(id);
    return task;
  }

  createTask(params: CreateTaskParams): TaskRecord {
    const id = generateId();
    const now = Date.now();
    const trackId = params.trackId ?? 'backlog';
    const parent = params.parentTaskId ? this.getTask(params.parentTaskId) : null;
    // The name this card's session launches under (SendMessage/ListAgents).
    // An explicit name always wins; otherwise a subtask's default is prefixed
    // with its parent's own sessionName, so the hierarchy reads directly off
    // the flat session list without anyone needing to look anything up.
    const sessionName =
      params.sessionName ??
      (parent ? `${parent.sessionName ?? parent.title}/${params.title}` : params.title);
    // Linking parent_task_id is not enough on its own: it tells the *board*
    // this card is a subtask, but nothing tells the *agent* that starts on
    // it — the brief is whatever free text the creator wrote, with no
    // guarantee it mentions the relationship at all. Prepending this here,
    // once, covers every creation path (CLI, TUI, auto-detected or explicit
    // --parent) rather than depending on each caller to remember to say it.
    const initialPrompt = parent
      ? [
          `[agentboard] This card is a subtask of "${parent.title}" ` +
            `(task id ${parent.id}, session name "${parent.sessionName ?? parent.title}"). ` +
            `Your own session name is "${sessionName}" — that is what SendMessage/ListAgents ` +
            `addresses you as; agentboard task notify addresses by task id instead, and this ` +
            `card's is ${id}. If you spin off further subtasks of your own, pass --parent ${id} ` +
            `explicitly rather than relying on auto-detection. When you open your pull request, ` +
            `message your parent session directly — ` +
            `SendMessage({to: "${parent.sessionName ?? parent.title}", message: "..."}) — rather ` +
            `than waiting to be asked; name the PR number and URL, and give a one-line summary of ` +
            `what it does.`,
          params.initialPrompt,
        ]
          .filter((part) => part && part.trim().length > 0)
          .join('\n\n')
      : params.initialPrompt;
    // Normalized rather than trusted: this runs on whatever the RPC layer hands over.
    const kind: TaskKind = params.kind === 'general' ? 'general' : 'repo';
    const isGeneral = kind === 'general';
    if (!isGeneral && !params.repoId) {
      throw new Error('createTask requires a repoId for repo tasks');
    }
    // A general task has nothing to branch from and nowhere to run remotely.
    const branchName = isGeneral ? null : createTaskBranchName(params.title);
    const agentCli = params.agentCli ?? 'claude';
    const location = isGeneral ? 'local' : (params.location ?? 'local');

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
           (id, title, description, initial_prompt, kind, parent_task_id, session_name, repo_id,
            agent_cli, location, track_id, pillar_id, branch_name, sort_key,
            pr_state, pr_draft, ci_state, review_state, unresolved_thread_count,
            github_sync_status, ci_required_total, ci_required_passed, ci_required_failed,
            ci_required_pending, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 0, 'none', 'none', 0, 'idle', 0, 0, 0, 0, ?, ?)`,
      )
      .run(
        id,
        params.title,
        emptyToNull(params.description),
        emptyToNull(initialPrompt),
        kind,
        params.parentTaskId ?? null,
        sessionName,
        isGeneral ? null : params.repoId!,
        agentCli,
        location,
        trackId,
        params.pillarId ?? null,
        branchName,
        sortKey,
        now,
        now,
      );

    // A repo card starts with the one branch it was created for. Everything
    // downstream reads branches, so a card without one would look like it has
    // no work in it at all.
    if (!isGeneral && params.repoId && branchName) {
      this.addTaskBranch({ taskId: id, repoId: params.repoId, branchName });
    }

    return this.getTask(id)!;
  }

  renameTask(id: string, title: string): void {
    const current = this.db
      .prepare<
        [string],
        {
          kind: string | null;
          branch_name: string | null;
          session_id: string | null;
          secondary_session_id: string | null;
        }
      >(
        'SELECT kind, branch_name, session_id, secondary_session_id FROM tasks WHERE id = ?',
      )
      .get(id);

    const branches = this.getTaskBranches(id);

    // A general task has no branch to follow the rename, and once a card spans
    // several branches there is no non-arbitrary one to rename — so the title
    // and the branches part ways there.
    if (
      current &&
      current.kind !== 'general' &&
      current.session_id == null &&
      current.secondary_session_id == null &&
      branches.length <= 1
    ) {
      const nextBranch = renameTaskBranchName(title, current.branch_name ?? undefined);
      this.db
        .prepare<[string, string, number, string], void>(
          'UPDATE tasks SET title = ?, branch_name = ?, updated_at = ? WHERE id = ?',
        )
        .run(title, nextBranch, Date.now(), id);

      const only = branches[0];
      if (only) {
        this.db
          .prepare<[string, number, string], void>(
            'UPDATE task_branches SET branch_name = ?, updated_at = ? WHERE id = ?',
          )
          .run(nextBranch, Date.now(), only.id);
      }
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

  updateTaskSync(id: string, fields: TaskSyncPatch): void {
    const { setClauses, values } = buildSyncClauses(fields);
    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(Date.now(), id);

    this.db
      .prepare<unknown[], void>(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  /**
   * Applies a sync patch to one branch, then re-rolls up the card.
   *
   * The card's own columns are derived from its branches, so writing a branch
   * without recomputing them would leave the board showing the state of
   * whichever branch happened to sync last.
   */
  updateTaskBranchSync(branchId: string, fields: TaskBranchSyncPatch): void {
    const { setClauses, values } = buildSyncClauses(fields);

    if (Object.prototype.hasOwnProperty.call(fields, 'mergeCommitSha')) {
      setClauses.push('merge_commit_sha = ?');
      values.push(fields.mergeCommitSha ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'mergedAt')) {
      setClauses.push('merged_at = ?');
      values.push(fields.mergedAt ?? null);
    }

    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    values.push(Date.now(), branchId);

    this.db
      .prepare<unknown[], void>(`UPDATE task_branches SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...values);

    const branch = this.getTaskBranch(branchId);
    if (branch) {
      this.recomputeTaskRollup(branch.taskId);
    }
  }

  /**
   * Rewrites a card's flat state from its branches.
   *
   * Every existing consumer — border colour, badges, filters, sorting — reads
   * those columns, so keeping them derived is what lets a card grow extra
   * branches without any of them changing.
   */
  recomputeTaskRollup(taskId: string): void {
    const branches = this.getTaskBranches(taskId);
    if (branches.length === 0) {
      return;
    }

    const rollup = rollupBranches(branches);

    this.db
      .prepare<unknown[], void>(
        `UPDATE tasks SET
           pr_number = ?, pr_url = ?, pr_state = ?, pr_draft = ?,
           ci_state = ?, ci_summary = ?, failing_check_name = ?,
           ci_required_total = ?, ci_required_passed = ?,
           ci_required_failed = ?, ci_required_pending = ?,
           review_state = ?, review_summary = ?, unresolved_thread_count = ?,
           git_state = ?, git_ahead_count = ?, git_behind_count = ?,
           has_untracked = ?, has_conflicts = ?,
           github_sync_status = ?, github_sync_error = ?, github_last_synced_at = ?,
           pr_count = ?, pr_open_count = ?, pr_merged_count = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        rollup.prNumber ?? null,
        rollup.prUrl ?? null,
        rollup.prState,
        rollup.prDraft ? 1 : 0,
        rollup.ciState,
        rollup.ciSummary ?? null,
        rollup.failingCheckName ?? null,
        rollup.ciRequiredTotal,
        rollup.ciRequiredPassed,
        rollup.ciRequiredFailed,
        rollup.ciRequiredPending,
        rollup.reviewState,
        rollup.reviewSummary ?? null,
        rollup.unresolvedThreadCount,
        rollup.gitState,
        rollup.gitAheadCount,
        rollup.gitBehindCount,
        rollup.hasUntracked ? 1 : 0,
        rollup.hasConflicts ? 1 : 0,
        rollup.githubSyncStatus,
        rollup.githubSyncError ?? null,
        rollup.githubLastSyncedAt ?? null,
        rollup.prCount,
        rollup.prOpenCount,
        rollup.prMergedCount,
        Date.now(),
        taskId,
      );
  }

  linkSession(
    taskId: string,
    sessionId: string,
    slot: import('../types/index.js').SessionSlot = 'primary',
  ): void {
    const column = slot === 'secondary' ? 'secondary_session_id' : 'session_id';
    this.db
      .prepare<unknown[], void>(
        `UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`,
      )
      .run(sessionId, Date.now(), taskId);
  }

  clearTaskSession(
    taskId: string,
    slot: import('../types/index.js').SessionSlot = 'primary',
  ): void {
    const column = slot === 'secondary' ? 'secondary_session_id' : 'session_id';
    this.db
      .prepare<unknown[], void>(
        `UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`,
      )
      .run(null, Date.now(), taskId);
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

  setTaskLocation(taskId: string, location: TaskLocation): void {
    this.db
      .prepare<[string, number, string], void>(
        'UPDATE tasks SET location = ?, updated_at = ? WHERE id = ?',
      )
      .run(location, Date.now(), taskId);
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

  /** Flags `parentTaskId`'s card: `childTaskId`'s pull request is ready to review. */
  setChildPrAlert(parentTaskId: string, childTaskId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare<[string, number, string]>(
        `UPDATE tasks
         SET child_pr_alert_task_id = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(childTaskId, now, parentTaskId);
    return result.changes > 0;
  }

  /** Marks or unmarks `taskId`'s card as an orchestrator. False if no such card. */
  setTaskOrchestrator(taskId: string, orchestrator: boolean): boolean {
    const result = this.db
      .prepare<[number, number, string]>(
        'UPDATE tasks SET is_orchestrator = ?, updated_at = ? WHERE id = ?',
      )
      .run(orchestrator ? 1 : 0, Date.now(), taskId);
    return result.changes > 0;
  }

  clearChildPrAlert(taskId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare<[number, string]>(
        `UPDATE tasks
         SET child_pr_alert_task_id = NULL,
             updated_at = ?
         WHERE id = ?
           AND child_pr_alert_task_id IS NOT NULL`,
      )
      .run(now, taskId);
    return result.changes > 0;
  }

  /**
   * Whether `parentTaskId` still has a subtask that has not reached `done`.
   *
   * Used to hold a parent card in `shipping` — and its session alive — until
   * every subtask it spun off is also done, not just its own branches. An
   * archived subtask does not count: archiving removes it from consideration
   * the same as it does everywhere else in the board.
   */
  hasIncompleteChildTasks(parentTaskId: string): boolean {
    const row = this.db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) AS count
         FROM tasks
         WHERE parent_task_id = ?
           AND archived_at IS NULL
           AND track_id <> 'done'`,
      )
      .get(parentTaskId);
    return (row?.count ?? 0) > 0;
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
    if (map.has('terminalPaneWidth'))
      state.terminalPaneWidth = map.get('terminalPaneWidth') as number;
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
