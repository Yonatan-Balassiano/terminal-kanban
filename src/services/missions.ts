import type { Db } from '../db/index.js';
import { generateId } from '../db/index.js';
import type {
  AddMissionTaskParams,
  CreateMissionParams,
  MissionRecord,
  MissionSnapshot,
  MissionStatusCounts,
  MissionTaskRecord,
  MissionTaskStatus,
  SetMissionTaskDependenciesParams,
  TaskRecord,
} from '../types/index.js';
import type { BoardService } from './board.js';

interface MissionRow {
  id: string;
  title: string;
  sort_key: number;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MissionTaskRow {
  mission_id: string;
  task_id: string;
  sort_key: number;
  released_to_board: number;
  released_at: number | null;
}

interface MissionDependencyRow {
  mission_id: string;
  blocker_task_id: string;
  blocked_task_id: string;
}

function emptyMissionCounts(): MissionStatusCounts {
  return {
    backlog: 0,
    inProgress: 0,
    pr: 0,
    merged: 0,
  };
}

function missionTaskStatus(task: TaskRecord): MissionTaskStatus {
  if (task.prState === 'merged' || task.trackId === 'done') {
    return 'merged';
  }
  if (task.trackId === 'pr' || task.prState === 'open' || task.prState === 'draft') {
    return 'pr';
  }
  if (task.trackId === 'in-progress') {
    return 'in-progress';
  }
  return 'backlog';
}

function isMissionTaskMerged(task: TaskRecord | undefined): boolean {
  return task !== undefined && missionTaskStatus(task) === 'merged';
}

function rowToMission(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    title: row.title,
    sortKey: row.sort_key,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MissionService {
  constructor(
    private db: Db,
    private board: BoardService,
  ) {}

  createMission(params: CreateMissionParams): MissionRecord {
    const title = params.title.trim();
    if (title === '') {
      throw new Error('Mission title cannot be empty');
    }

    const id = generateId();
    const now = Date.now();
    const maxRow = this.db
      .prepare<[], { max_key: number | null }>('SELECT MAX(sort_key) AS max_key FROM missions')
      .get();
    const sortKey = (maxRow?.max_key ?? 0) + 1000;

    this.db
      .prepare<[string, string, number, number, number], void>(
        `INSERT INTO missions (id, title, sort_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title, sortKey, now, now);

    return {
      id,
      title,
      sortKey,
      createdAt: now,
      updatedAt: now,
    };
  }

  addMissionTask(params: AddMissionTaskParams): MissionTaskRecord {
    this.requireMission(params.missionId);

    const task = this.board.createTask({
      title: params.title,
      repoId: params.repoId,
      agentCli: params.agentCli,
      pillarId: params.pillarId,
      trackId: 'backlog',
    });

    const blockerTaskIds = this.normalizeBlockerTaskIds(
      params.missionId,
      task.id,
      params.blockerTaskIds ?? [],
    );

    const now = Date.now();
    const maxRow = this.db
      .prepare<[string], { max_key: number | null }>(
        'SELECT MAX(sort_key) AS max_key FROM mission_tasks WHERE mission_id = ?',
      )
      .get(params.missionId);
    const sortKey = (maxRow?.max_key ?? 0) + 1000;

    const insertTask = this.db.prepare<[string, string, number, number, number], void>(
      `INSERT INTO mission_tasks
         (mission_id, task_id, sort_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertDependency = this.db.prepare<[string, string, string, number], void>(
      `INSERT OR IGNORE INTO mission_dependencies
         (mission_id, blocker_task_id, blocked_task_id, created_at)
       VALUES (?, ?, ?, ?)`,
    );

    const apply = this.db.transaction(() => {
      insertTask.run(params.missionId, task.id, sortKey, now, now);
      for (const blockerTaskId of blockerTaskIds) {
        insertDependency.run(params.missionId, blockerTaskId, task.id, now);
      }
      this.touchMission(params.missionId, now);
    });

    apply();
    this.reconcileMission(params.missionId);

    const mission = this.listMissions().find((candidate) => candidate.id === params.missionId);
    const missionTask = mission?.tasks.find((candidate) => candidate.taskId === task.id);
    if (!missionTask) {
      throw new Error(`Mission task was not created for mission ${params.missionId}`);
    }
    return missionTask;
  }

  setMissionTaskDependencies(params: SetMissionTaskDependenciesParams): void {
    this.requireMissionTask(params.missionId, params.taskId);
    const blockerTaskIds = this.normalizeBlockerTaskIds(
      params.missionId,
      params.taskId,
      params.blockerTaskIds,
    );
    const now = Date.now();

    const deleteDependencies = this.db.prepare<[string, string], void>(
      `DELETE FROM mission_dependencies
       WHERE mission_id = ? AND blocked_task_id = ?`,
    );
    const insertDependency = this.db.prepare<[string, string, string, number], void>(
      `INSERT OR IGNORE INTO mission_dependencies
         (mission_id, blocker_task_id, blocked_task_id, created_at)
       VALUES (?, ?, ?, ?)`,
    );

    const apply = this.db.transaction(() => {
      deleteDependencies.run(params.missionId, params.taskId);
      for (const blockerTaskId of blockerTaskIds) {
        insertDependency.run(params.missionId, blockerTaskId, params.taskId, now);
      }
      this.touchMission(params.missionId, now);
    });

    apply();
    this.reconcileMission(params.missionId);
  }

  releaseMissionTaskToBoard(taskId: string): boolean {
    const missionId = this.missionIdForTask(taskId);
    if (!missionId) {
      throw new Error(`Task ${taskId} is not part of a mission`);
    }

    const now = Date.now();
    const result = this.db
      .prepare<[number, number, string], { changes: number }>(
        `UPDATE mission_tasks
         SET released_to_board = 1,
             released_at = COALESCE(released_at, ?),
             updated_at = ?
         WHERE task_id = ?
           AND released_to_board = 0`,
      )
      .run(now, now, taskId);

    if (result.changes > 0) {
      this.touchMission(missionId, now);
      return true;
    }
    return false;
  }

  reconcileTaskCompletion(taskId: string): string[] {
    const missionId = this.missionIdForTask(taskId);
    if (!missionId) {
      return [];
    }
    return this.reconcileMission(missionId);
  }

  listMissions(): MissionSnapshot[] {
    const missionRows = this.db
      .prepare<[], MissionRow>('SELECT * FROM missions ORDER BY sort_key, created_at')
      .all();
    if (missionRows.length === 0) {
      return [];
    }

    const taskMap = new Map(
      this.board
        .getAllTasks({ includeArchived: true })
        .map((task) => [task.id, task] as const),
    );

    const missionTaskRows = this.db
      .prepare<[], MissionTaskRow>(
        `SELECT mission_id, task_id, sort_key, released_to_board, released_at
         FROM mission_tasks
         ORDER BY mission_id, sort_key, created_at`,
      )
      .all();
    const dependencyRows = this.db
      .prepare<[], MissionDependencyRow>(
        `SELECT mission_id, blocker_task_id, blocked_task_id
         FROM mission_dependencies`,
      )
      .all();

    const blockersByBlocked = new Map<string, string[]>();
    const blockedByBlocker = new Map<string, string[]>();
    for (const row of dependencyRows) {
      const blockers = blockersByBlocked.get(row.blocked_task_id) ?? [];
      blockers.push(row.blocker_task_id);
      blockersByBlocked.set(row.blocked_task_id, blockers);

      const blocked = blockedByBlocker.get(row.blocker_task_id) ?? [];
      blocked.push(row.blocked_task_id);
      blockedByBlocker.set(row.blocker_task_id, blocked);
    }

    const tasksByMission = new Map<string, MissionTaskRecord[]>();
    for (const row of missionTaskRows) {
      const task = taskMap.get(row.task_id);
      if (!task) {
        continue;
      }

      const blockerTaskIds = blockersByBlocked.get(row.task_id) ?? [];
      const blockedTaskIds = blockedByBlocker.get(row.task_id) ?? [];
      const isBlocked = blockerTaskIds.some((blockerTaskId) => !isMissionTaskMerged(taskMap.get(blockerTaskId)));

      const missionTask: MissionTaskRecord = {
        missionId: row.mission_id,
        taskId: row.task_id,
        sortKey: row.sort_key,
        releasedToBoard: row.released_to_board === 1,
        releasedAt: row.released_at ?? undefined,
        blockerTaskIds,
        blockedTaskIds,
        status: missionTaskStatus(task),
        isBlocked,
        task,
      };

      const missionTasks = tasksByMission.get(row.mission_id) ?? [];
      missionTasks.push(missionTask);
      tasksByMission.set(row.mission_id, missionTasks);
    }

    return missionRows.map((row) => {
      const missionTasks = tasksByMission.get(row.id) ?? [];
      const counts = emptyMissionCounts();
      for (const missionTask of missionTasks) {
        switch (missionTask.status) {
          case 'in-progress':
            counts.inProgress += 1;
            break;
          case 'pr':
            counts.pr += 1;
            break;
          case 'merged':
            counts.merged += 1;
            break;
          default:
            counts.backlog += 1;
            break;
        }
      }

      return {
        ...rowToMission(row),
        counts,
        tasks: missionTasks,
      };
    });
  }

  private reconcileMission(missionId: string): string[] {
    const mission = this.listMissions().find((candidate) => candidate.id === missionId);
    if (!mission) {
      return [];
    }

    const newlyReadyTaskIds = mission.tasks
      .filter((task) => !task.releasedToBoard && !task.isBlocked)
      .map((task) => task.taskId);
    if (newlyReadyTaskIds.length > 0) {
      this.releaseMissionTasks(newlyReadyTaskIds);
    }

    const allMerged = mission.tasks.length > 0 && mission.tasks.every((task) => task.status === 'merged');
    const current = this.db
      .prepare<[string], { completed_at: number | null }>(
        'SELECT completed_at FROM missions WHERE id = ?',
      )
      .get(missionId);
    const nextCompletedAt = allMerged ? current?.completed_at ?? Date.now() : null;

    if ((current?.completed_at ?? null) !== nextCompletedAt || newlyReadyTaskIds.length > 0) {
      this.db
        .prepare<[number | null, number, string], void>(
          'UPDATE missions SET completed_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(nextCompletedAt, Date.now(), missionId);
    }

    return newlyReadyTaskIds;
  }

  private releaseMissionTasks(taskIds: string[]): void {
    if (taskIds.length === 0) {
      return;
    }

    const now = Date.now();
    const placeholders = taskIds.map(() => '?').join(',');
    this.db
      .prepare<unknown[], void>(
        `UPDATE mission_tasks
         SET released_to_board = 1,
             released_at = COALESCE(released_at, ?),
             updated_at = ?
         WHERE task_id IN (${placeholders})
           AND released_to_board = 0`,
      )
      .run(now, now, ...taskIds);
  }

  private missionIdForTask(taskId: string): string | null {
    const row = this.db
      .prepare<[string], { mission_id: string }>(
        'SELECT mission_id FROM mission_tasks WHERE task_id = ?',
      )
      .get(taskId);
    return row?.mission_id ?? null;
  }

  private requireMission(missionId: string): void {
    const row = this.db
      .prepare<[string], { id: string }>('SELECT id FROM missions WHERE id = ?')
      .get(missionId);
    if (!row) {
      throw new Error(`Mission not found: ${missionId}`);
    }
  }

  private requireMissionTask(missionId: string, taskId: string): void {
    const row = this.db
      .prepare<[string, string], { mission_id: string; task_id: string }>(
        'SELECT mission_id, task_id FROM mission_tasks WHERE mission_id = ? AND task_id = ?',
      )
      .get(missionId, taskId);
    if (!row) {
      throw new Error(`Task ${taskId} is not part of mission ${missionId}`);
    }
  }

  private normalizeBlockerTaskIds(
    missionId: string,
    taskId: string,
    blockerTaskIds: string[],
  ): string[] {
    const unique = [...new Set(blockerTaskIds.filter((blockerTaskId) => blockerTaskId !== taskId))];
    if (unique.length === 0) {
      return [];
    }

    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db
      .prepare<unknown[], { task_id: string }>(
        `SELECT task_id
         FROM mission_tasks
         WHERE mission_id = ?
           AND task_id IN (${placeholders})`,
      )
      .all(missionId, ...unique);
    const allowed = new Set(rows.map((row) => row.task_id));

    for (const blockerTaskId of unique) {
      if (!allowed.has(blockerTaskId)) {
        throw new Error(`Blocker task ${blockerTaskId} is not part of mission ${missionId}`);
      }
    }

    return unique;
  }

  private touchMission(missionId: string, now = Date.now()): void {
    this.db
      .prepare<[number, string], void>('UPDATE missions SET updated_at = ? WHERE id = ?')
      .run(now, missionId);
  }
}
