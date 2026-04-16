import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { MissionService } from '../src/services/missions.js';
import { ViewService } from '../src/services/view.js';

describe('MissionService', () => {
  let db: Db;
  let board: BoardService;
  let missions: MissionService;
  let view: ViewService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    missions = new MissionService(db, board);
    view = new ViewService(board, missions);

    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'Repo', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db?.close();
  });

  it('auto-releases mission tasks without blockers into the board backlog', () => {
    const mission = missions.createMission({ title: 'Cross repo release' });
    const missionTask = missions.addMissionTask({
      missionId: mission.id,
      title: 'Lay the groundwork',
      repoId: 'repo-1',
    });

    expect(missionTask.releasedToBoard).toBe(true);
    expect(board.getTasks().map((task) => task.id)).toContain(missionTask.taskId);

    const snapshot = view.getBoardSnapshot();
    expect(snapshot.missions).toHaveLength(1);
    expect(snapshot.missions[0].counts.backlog).toBe(1);
    expect(snapshot.missions[0].tasks[0].releasedToBoard).toBe(true);
  });

  it('keeps blocked mission tasks hidden until the blocker is merged', () => {
    const mission = missions.createMission({ title: 'Dependency chain' });
    const blocker = missions.addMissionTask({
      missionId: mission.id,
      title: 'Base PR',
      repoId: 'repo-1',
    });
    const blocked = missions.addMissionTask({
      missionId: mission.id,
      title: 'Follow-up PR',
      repoId: 'repo-1',
      blockerTaskIds: [blocker.taskId],
    });

    expect(blocked.releasedToBoard).toBe(false);
    expect(board.getTasks().map((task) => task.id)).not.toContain(blocked.taskId);

    board.updateTaskSync(blocker.taskId, { prState: 'merged' });
    board.moveTask({ id: blocker.taskId, trackId: 'done' });
    missions.reconcileTaskCompletion(blocker.taskId);

    expect(board.getTasks().map((task) => task.id)).toContain(blocked.taskId);
  });

  it('allows manually releasing a blocked mission task and completes the mission when all tasks are merged', () => {
    const mission = missions.createMission({ title: 'Manual override flow' });
    const blocker = missions.addMissionTask({
      missionId: mission.id,
      title: 'Base task',
      repoId: 'repo-1',
    });
    const blocked = missions.addMissionTask({
      missionId: mission.id,
      title: 'Blocked task',
      repoId: 'repo-1',
      blockerTaskIds: [blocker.taskId],
    });

    expect(missions.releaseMissionTaskToBoard(blocked.taskId)).toBe(true);
    expect(board.getTasks().map((task) => task.id)).toContain(blocked.taskId);

    board.updateTaskSync(blocker.taskId, { prState: 'merged' });
    board.moveTask({ id: blocker.taskId, trackId: 'done' });
    missions.reconcileTaskCompletion(blocker.taskId);

    board.updateTaskSync(blocked.taskId, { prState: 'merged' });
    board.moveTask({ id: blocked.taskId, trackId: 'done' });
    missions.reconcileTaskCompletion(blocked.taskId);

    const snapshot = view.getBoardSnapshot();
    expect(snapshot.missions[0].completedAt).toBeDefined();
    expect(snapshot.missions[0].counts.merged).toBe(2);
  });
});
