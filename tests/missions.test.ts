import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { MissionService } from '../src/services/missions.js';

describe('MissionService', () => {
  let db: Db;
  let board: BoardService;
  let missions: MissionService;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    missions = new MissionService(db, board);

    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'Repo One', '/tmp/repo-1', null, null, 'main', null, 'ok', 1, 1);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-2', 'Repo Two', '/tmp/repo-2', null, null, 'main', null, 'ok', 1, 1);
  });

  it('marks root steps ready and dependent steps planned', () => {
    const mission = missions.createMission({ title: 'Ship the thing' });
    const first = missions.addMissionStep({
      missionId: mission.id,
      title: 'Repo one prep',
      repoId: 'repo-1',
    });
    missions.addMissionStep({
      missionId: mission.id,
      title: 'Repo two follow-up',
      repoId: 'repo-2',
      dependsOnStepId: first.id,
    });

    const detail = missions.getMission(mission.id);

    expect(detail.mission.readySteps).toBe(1);
    expect(detail.mission.blockedSteps).toBe(1);
    expect(detail.steps.map((step) => step.status)).toEqual(['ready', 'planned']);
  });

  it('materializes a ready step into a normal task and reuses it on repeated starts', () => {
    const mission = missions.createMission({ title: 'Split the work' });
    const step = missions.addMissionStep({
      missionId: mission.id,
      title: 'Implement repo one change',
      repoId: 'repo-1',
    });

    const firstTask = missions.startMissionStep(step.id);
    const secondTask = missions.startMissionStep(step.id);
    const detail = missions.getMission(mission.id);

    expect(secondTask.id).toBe(firstTask.id);
    expect(board.getTask(firstTask.id)?.title).toBe('Implement repo one change');
    expect(detail.steps[0]).toMatchObject({
      id: step.id,
      status: 'active',
      linkedTaskId: firstTask.id,
    });
  });

  it('marks linked steps done when their task reaches done and auto-closes the mission', () => {
    const mission = missions.createMission({ title: 'Finish the chain' });
    const step = missions.addMissionStep({
      missionId: mission.id,
      title: 'Finish repo one',
      repoId: 'repo-1',
    });

    const task = missions.startMissionStep(step.id);
    board.moveTask({ id: task.id, trackId: 'done' });

    const detail = missions.getMission(mission.id);

    expect(detail.steps[0]?.status).toBe('done');
    expect(detail.mission.status).toBe('done');
    expect(detail.mission.completedAt).toBeDefined();
  });

  it('rewinds an unfinished linked step when its task is archived', () => {
    const mission = missions.createMission({ title: 'Recover from archive' });
    const step = missions.addMissionStep({
      missionId: mission.id,
      title: 'Retryable step',
      repoId: 'repo-1',
    });

    const task = missions.startMissionStep(step.id);
    board.archiveTask(task.id);

    const detail = missions.getMission(mission.id);

    expect(detail.steps[0]?.status).toBe('ready');
    expect(detail.steps[0]?.linkedTaskId).toBeUndefined();
    expect(detail.mission.status).toBe('open');
  });
});
