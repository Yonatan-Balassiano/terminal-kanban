import type { Db } from '../db/index.js';
import { generateId } from '../db/index.js';
import type {
  AddMissionStepParams,
  CreateMissionParams,
  MissionDetail,
  MissionRecord,
  MissionStatus,
  MissionStepRecord,
  MissionStepStatus,
  MissionSummaryRecord,
  ReorderMissionStepParams,
  TaskRecord,
  UpdateMissionParams,
  UpdateMissionStepParams,
} from '../types/index.js';

interface MissionRow {
  id: string;
  title: string;
  description: string | null;
  status: MissionStatus;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface MissionStepRow {
  id: string;
  mission_id: string;
  title: string;
  description: string | null;
  repo_id: string;
  sort_order: number;
  status: MissionStepStatus;
  depends_on_step_id: string | null;
  linked_task_id: string | null;
  created_at: number;
  updated_at: number;
}

interface MissionStepStateRow extends MissionStepRow {
  task_track_id: string | null;
  task_archived_at: number | null;
}

interface ReconcileOutcome {
  status: MissionStepStatus;
  clearLink: boolean;
}

function rowToMission(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMissionStep(row: MissionStepRow): MissionStepRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    title: row.title,
    description: row.description ?? undefined,
    repoId: row.repo_id,
    sortOrder: row.sort_order,
    status: row.status,
    dependsOnStepId: row.depends_on_step_id ?? undefined,
    linkedTaskId: row.linked_task_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function summaryFromMission(mission: MissionRecord, steps: MissionStepRecord[]): MissionSummaryRecord {
  const repoIds = Array.from(new Set(steps.map((step) => step.repoId)));
  const completedSteps = steps.filter((step) => step.status === 'done').length;
  const readySteps = steps.filter((step) => step.status === 'ready').length;
  const activeSteps = steps.filter((step) => step.status === 'active').length;
  const blockedSteps = steps.filter((step) => step.status === 'planned').length;
  const skippedSteps = steps.filter((step) => step.status === 'skipped').length;
  return {
    ...mission,
    totalSteps: steps.length,
    completedSteps,
    readySteps,
    activeSteps,
    blockedSteps,
    skippedSteps,
    repoIds,
  };
}

export class MissionService {
  constructor(
    private db: Db,
    private board: {
      createTask(params: {
        title: string;
        repoId: string;
        trackId?: string;
        pillarId?: string;
      }): TaskRecord;
      getTask(id: string): TaskRecord | null;
      setTaskDescription?(id: string, description: string): void;
    },
  ) {}

  listMissions(): MissionSummaryRecord[] {
    const missionIds = this.db
      .prepare<[], { id: string }>(
        `SELECT id
         FROM missions
         ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC, created_at DESC`,
      )
      .all()
      .map((row: { id: string }) => row.id);

    return missionIds.map((missionId: string) => this.getMission(missionId).mission);
  }

  getMission(id: string): MissionDetail {
    this.reconcileMission(id);
    const mission = this.loadMission(id);
    if (!mission) {
      throw new Error(`Mission not found: ${id}`);
    }
    const steps = this.loadMissionSteps(id);
    return {
      mission: summaryFromMission(mission, steps),
      steps,
    };
  }

  createMission(params: CreateMissionParams): MissionRecord {
    const title = params.title.trim();
    if (title.length === 0) {
      throw new Error('Mission title is required');
    }

    const id = generateId();
    const now = Date.now();
    this.db
      .prepare<[string, string, string | null, number, number], void>(
        `INSERT INTO missions (id, title, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title, params.description?.trim() || null, now, now);

    return this.loadMission(id)!;
  }

  updateMission(params: UpdateMissionParams): MissionRecord {
    const current = this.loadMission(params.id);
    if (!current) {
      throw new Error(`Mission not found: ${params.id}`);
    }

    const title = params.title === undefined ? current.title : params.title.trim();
    if (title.length === 0) {
      throw new Error('Mission title is required');
    }

    const description =
      params.description === undefined ? current.description ?? null : params.description.trim() || null;

    this.db
      .prepare<[string, string | null, number, string], void>(
        'UPDATE missions SET title = ?, description = ?, updated_at = ? WHERE id = ?',
      )
      .run(title, description, Date.now(), params.id);

    return this.loadMission(params.id)!;
  }

  addMissionStep(params: AddMissionStepParams): MissionStepRecord {
    this.ensureMissionExists(params.missionId);
    this.ensureRepoExists(params.repoId);

    const title = params.title.trim();
    if (title.length === 0) {
      throw new Error('Mission step title is required');
    }

    if (params.dependsOnStepId) {
      this.ensureStepBelongsToMission(params.dependsOnStepId, params.missionId);
    }

    const nextSortOrder =
      (this.db
        .prepare<[string], { max_sort_order: number | null }>(
          'SELECT MAX(sort_order) AS max_sort_order FROM mission_steps WHERE mission_id = ?',
        )
        .get(params.missionId)?.max_sort_order ?? -1) + 1;

    const id = generateId();
    const now = Date.now();
    this.db
      .prepare<
        [string, string, string, string | null, string, number, MissionStepStatus, string | null, number, number],
        void
      >(
        `INSERT INTO mission_steps
           (id, mission_id, title, description, repo_id, sort_order, status, depends_on_step_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.missionId,
        title,
        params.description?.trim() || null,
        params.repoId,
        nextSortOrder,
        'planned',
        params.dependsOnStepId ?? null,
        now,
        now,
      );

    this.touchMission(params.missionId);
    this.reconcileMission(params.missionId);
    return this.loadMissionStep(id)!;
  }

  updateMissionStep(params: UpdateMissionStepParams): MissionStepRecord {
    const current = this.loadMissionStep(params.id);
    if (!current) {
      throw new Error(`Mission step not found: ${params.id}`);
    }
    if (current.linkedTaskId) {
      throw new Error(`Mission step ${params.id} already has a linked task`);
    }

    const title = params.title === undefined ? current.title : params.title.trim();
    if (title.length === 0) {
      throw new Error('Mission step title is required');
    }

    const repoId = params.repoId ?? current.repoId;
    this.ensureRepoExists(repoId);

    let dependsOnStepId: string | null | undefined = current.dependsOnStepId ?? null;
    if (params.dependsOnStepId !== undefined) {
      dependsOnStepId = params.dependsOnStepId;
      if (dependsOnStepId) {
        if (dependsOnStepId === current.id) {
          throw new Error('Mission step cannot depend on itself');
        }
        this.ensureStepBelongsToMission(dependsOnStepId, current.missionId);
      }
    }

    const description =
      params.description === undefined ? current.description ?? null : params.description.trim() || null;

    this.db
      .prepare<[string, string | null, string, string | null, number, string], void>(
        `UPDATE mission_steps
         SET title = ?, description = ?, repo_id = ?, depends_on_step_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(title, description, repoId, dependsOnStepId ?? null, Date.now(), params.id);

    this.touchMission(current.missionId);
    this.reconcileMission(current.missionId);
    return this.loadMissionStep(params.id)!;
  }

  reorderMissionStep(params: ReorderMissionStepParams): MissionStepRecord {
    const current = this.loadMissionStep(params.id);
    if (!current) {
      throw new Error(`Mission step not found: ${params.id}`);
    }

    const ordered = this.loadMissionSteps(current.missionId);
    const next = ordered.filter((step) => step.id !== current.id);
    const targetIndex = Math.max(0, Math.min(params.sortOrder, next.length));
    next.splice(targetIndex, 0, current);

    const now = Date.now();
    const apply = this.db.transaction(() => {
      const stmt = this.db.prepare<[number, number, string], void>(
        'UPDATE mission_steps SET sort_order = ?, updated_at = ? WHERE id = ?',
      );
      next.forEach((step, index) => {
        stmt.run(index, now, step.id);
      });
      this.touchMission(current.missionId, now);
    });

    apply();
    this.reconcileMission(current.missionId);
    return this.loadMissionStep(params.id)!;
  }

  startMissionStep(stepId: string): TaskRecord {
    const detail = this.getMissionForStep(stepId);
    const step = detail.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new Error(`Mission step not found: ${stepId}`);
    }

    if (step.linkedTaskId) {
      const task = this.board.getTask(step.linkedTaskId);
      if (task) {
        return task;
      }
    }

    if (step.status !== 'ready') {
      throw new Error(`Mission step ${step.id} is not ready`);
    }

    const task = this.board.createTask({
      title: step.title,
      repoId: step.repoId,
      trackId: 'backlog',
    });
    if (step.description) {
      this.board.setTaskDescription?.(task.id, step.description);
    }

    const now = Date.now();
    this.db
      .prepare<[string, MissionStepStatus, number, string], void>(
        'UPDATE mission_steps SET linked_task_id = ?, status = ?, updated_at = ? WHERE id = ?',
      )
      .run(task.id, 'active', now, step.id);
    this.touchMission(step.missionId, now);

    return task;
  }

  startNextMissionStep(missionId: string): TaskRecord {
    const detail = this.getMission(missionId);
    const nextStep = detail.steps.find((step) => step.status === 'ready');
    if (!nextStep) {
      throw new Error(`Mission ${missionId} has no ready steps`);
    }
    return this.startMissionStep(nextStep.id);
  }

  startAllReadyMissionSteps(missionId: string): TaskRecord[] {
    const detail = this.getMission(missionId);
    const readySteps = detail.steps.filter((step) => step.status === 'ready');
    if (readySteps.length === 0) {
      return [];
    }
    return readySteps.map((step) => this.startMissionStep(step.id));
  }

  setMissionStepStatus(stepId: string, status: MissionStepStatus): MissionStepRecord {
    const current = this.loadMissionStep(stepId);
    if (!current) {
      throw new Error(`Mission step not found: ${stepId}`);
    }

    if (current.linkedTaskId && status !== 'done') {
      throw new Error(`Mission step ${stepId} already has a linked task`);
    }

    let nextStatus = status;
    if (status === 'ready' || status === 'planned') {
      nextStatus = this.computeDependencyStatus(current.missionId, current.dependsOnStepId ?? null);
    }

    const now = Date.now();
    this.db
      .prepare<[MissionStepStatus, number, string], void>(
        'UPDATE mission_steps SET status = ?, updated_at = ? WHERE id = ?',
      )
      .run(nextStatus, now, stepId);
    this.touchMission(current.missionId, now);
    this.reconcileMission(current.missionId);

    return this.loadMissionStep(stepId)!;
  }

  private getMissionForStep(stepId: string): MissionDetail {
    const row = this.db
      .prepare<[string], { mission_id: string }>('SELECT mission_id FROM mission_steps WHERE id = ?')
      .get(stepId);
    if (!row) {
      throw new Error(`Mission step not found: ${stepId}`);
    }
    return this.getMission(row.mission_id);
  }

  private reconcileMission(missionId: string): void {
    const mission = this.loadMission(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    const rows = this.db
      .prepare<[string], MissionStepStateRow>(
        `SELECT
           ms.*,
           t.track_id AS task_track_id,
           t.archived_at AS task_archived_at
         FROM mission_steps ms
         LEFT JOIN tasks t ON t.id = ms.linked_task_id
         WHERE ms.mission_id = ?
         ORDER BY ms.sort_order, ms.created_at`,
      )
      .all(missionId);

    const byId = new Map<string, MissionStepStateRow>(
      rows.map((row: MissionStepStateRow): [string, MissionStepStateRow] => [row.id, row]),
    );
    const resolved = new Map<string, ReconcileOutcome>();
    const inFlight = new Set<string>();

    const computeOutcome = (stepId: string): ReconcileOutcome => {
      const cached = resolved.get(stepId);
      if (cached) {
        return cached;
      }

      const row = byId.get(stepId);
      if (!row) {
        return { status: 'planned', clearLink: false };
      }

      if (inFlight.has(stepId)) {
        return { status: 'planned', clearLink: false };
      }
      inFlight.add(stepId);

      let dependencySatisfied = true;
      if (row.depends_on_step_id) {
        const dependency = computeOutcome(row.depends_on_step_id);
        dependencySatisfied = dependency.status === 'done' || dependency.status === 'skipped';
      }

      let outcome: ReconcileOutcome;
      if (row.linked_task_id) {
        if (row.task_track_id == null) {
          outcome = {
            status: row.status === 'done' ? 'done' : ternaryStatus(dependencySatisfied),
            clearLink: true,
          };
        } else if (row.task_archived_at != null && row.status !== 'done' && row.task_track_id !== 'done') {
          outcome = {
            status: ternaryStatus(dependencySatisfied),
            clearLink: true,
          };
        } else if (row.task_track_id === 'done') {
          outcome = {
            status: 'done',
            clearLink: false,
          };
        } else {
          outcome = {
            status: 'active',
            clearLink: false,
          };
        }
      } else if (row.status === 'done' || row.status === 'skipped') {
        outcome = {
          status: row.status,
          clearLink: false,
        };
      } else {
        outcome = {
          status: ternaryStatus(dependencySatisfied),
          clearLink: false,
        };
      }

      inFlight.delete(stepId);
      resolved.set(stepId, outcome);
      return outcome;
    };

    const now = Date.now();
    const updateStep = this.db.prepare<[string | null, MissionStepStatus, number, string], void>(
      `UPDATE mission_steps
       SET linked_task_id = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    );

    let stepChanged = false;
    for (const row of rows) {
      const next = computeOutcome(row.id);
      const nextLink = next.clearLink ? null : row.linked_task_id;
      if (row.status !== next.status || row.linked_task_id !== nextLink) {
        updateStep.run(nextLink, next.status, now, row.id);
        stepChanged = true;
      }
    }

    const nextSteps: MissionStepRecord[] = rows.map((row: MissionStepStateRow) => {
      const outcome = computeOutcome(row.id);
      return {
        ...rowToMissionStep({
          ...row,
          linked_task_id: outcome.clearLink ? null : row.linked_task_id,
          status: outcome.status,
        }),
      };
    });

    const nextMissionStatus: MissionStatus = nextSteps.every(
      (step) => step.status === 'done' || step.status === 'skipped',
    )
      ? 'done'
      : 'open';

    if (mission.status !== nextMissionStatus || (nextMissionStatus === 'done') !== Boolean(mission.completedAt) || stepChanged) {
      this.db
        .prepare<[MissionStatus, number | null, number, string], void>(
          'UPDATE missions SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(nextMissionStatus, nextMissionStatus === 'done' ? now : null, now, missionId);
    }
  }

  private ensureMissionExists(missionId: string): void {
    if (!this.loadMission(missionId)) {
      throw new Error(`Mission not found: ${missionId}`);
    }
  }

  private ensureRepoExists(repoId: string): void {
    const row = this.db
      .prepare<[string], { id: string }>('SELECT id FROM repos WHERE id = ?')
      .get(repoId);
    if (!row) {
      throw new Error(`Repo not found: ${repoId}`);
    }
  }

  private ensureStepBelongsToMission(stepId: string, missionId: string): void {
    const row = this.db
      .prepare<[string], { mission_id: string }>('SELECT mission_id FROM mission_steps WHERE id = ?')
      .get(stepId);
    if (!row) {
      throw new Error(`Mission step not found: ${stepId}`);
    }
    if (row.mission_id !== missionId) {
      throw new Error(`Mission step ${stepId} does not belong to mission ${missionId}`);
    }
  }

  private loadMission(id: string): MissionRecord | null {
    const row = this.db
      .prepare<[string], MissionRow>('SELECT * FROM missions WHERE id = ?')
      .get(id);
    return row ? rowToMission(row) : null;
  }

  private loadMissionSteps(missionId: string): MissionStepRecord[] {
    return this.db
      .prepare<[string], MissionStepRow>(
        'SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY sort_order, created_at',
      )
      .all(missionId)
      .map((row: MissionStepRow) => rowToMissionStep(row));
  }

  private loadMissionStep(id: string): MissionStepRecord | null {
    const row = this.db
      .prepare<[string], MissionStepRow>('SELECT * FROM mission_steps WHERE id = ?')
      .get(id);
    return row ? rowToMissionStep(row) : null;
  }

  private computeDependencyStatus(
    missionId: string,
    dependsOnStepId: string | null,
  ): MissionStepStatus {
    if (!dependsOnStepId) {
      return 'ready';
    }
    this.reconcileMission(missionId);
    const dependency = this.loadMissionStep(dependsOnStepId);
    if (!dependency) {
      return 'planned';
    }
    return dependency.status === 'done' || dependency.status === 'skipped' ? 'ready' : 'planned';
  }

  private touchMission(missionId: string, timestamp = Date.now()): void {
    this.db
      .prepare<[number, string], void>('UPDATE missions SET updated_at = ? WHERE id = ?')
      .run(timestamp, missionId);
  }
}

function ternaryStatus(dependencySatisfied: boolean): MissionStepStatus {
  return dependencySatisfied ? 'ready' : 'planned';
}
