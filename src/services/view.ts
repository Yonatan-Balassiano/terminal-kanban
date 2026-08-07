import type { BoardSnapshot, FilterModel, TaskRecord } from '../types/index.js';
import type { BoardService } from './board.js';
import type { MissionService } from './missions.js';
import { rowToRepo } from './workspace.js';

export class ViewService {
  constructor(
    private board: BoardService,
    private missions: MissionService,
  ) {}

  applyFilter(tasks: TaskRecord[], filter: FilterModel): TaskRecord[] {
    return tasks.filter((task) => {
      // includeArchived: exclude archived tasks unless explicitly requested
      if (!filter.includeArchived && task.archivedAt !== undefined) {
        return false;
      }

      // repoIds — a general task belongs to no repo, so any repo filter excludes it
      if (filter.repoIds && filter.repoIds.length > 0) {
        if (task.repoId === undefined || !filter.repoIds.includes(task.repoId)) return false;
      }

      // pillarIds
      if (filter.pillarIds && filter.pillarIds.length > 0) {
        if (!task.pillarId || !filter.pillarIds.includes(task.pillarId)) return false;
      }

      // labelIds — task must have at least one matching label
      if (filter.labelIds && filter.labelIds.length > 0) {
        const hasMatch = task.labels.some((l) => filter.labelIds!.includes(l));
        if (!hasMatch) return false;
      }

      // trackIds
      if (filter.trackIds && filter.trackIds.length > 0) {
        if (!filter.trackIds.includes(task.trackId)) return false;
      }

      // prState
      if (filter.prState && filter.prState.length > 0) {
        if (!filter.prState.includes(task.prState)) return false;
      }

      // ciState
      if (filter.ciState && filter.ciState.length > 0) {
        if (!filter.ciState.includes(task.ciState)) return false;
      }

      // sessionState — lives on SessionRecord, not TaskRecord; pass through
      // (no-op here)

      // searchText — case-insensitive match against title and branchName
      if (filter.searchText && filter.searchText.length > 0) {
        const needle = filter.searchText.toLowerCase();
        const inTitle = task.title.toLowerCase().includes(needle);
        const inBranch = task.branchName?.toLowerCase().includes(needle) ?? false;
        if (!inTitle && !inBranch) return false;
      }

      return true;
    });
  }

  resolveView(viewId: string): FilterModel | null {
    const views = this.board.getSavedViews();
    const view = views.find((v) => v.id === viewId);
    return view?.filters ?? null;
  }

  getBoardSnapshot(repoId?: string, filter?: FilterModel): BoardSnapshot {
    const pillars = this.board.getPillars();
    const labels = this.board.getLabels();
    const savedViews = this.board.getSavedViews();
    const uiState = this.board.getUIState();
    const missions = this.missions.listMissions();

    // Tasks: already filtered by repoId; apply additional filter if provided
    let tasks = this.board.getTasks({ repoId, includeArchived: filter?.includeArchived });
    if (filter) {
      tasks = this.applyFilter(tasks, filter);
    }

    // Tracks come from the DB via a separate query — build directly here
    const trackRows = (this.board as unknown as { db: import('../db/index.js').Db }).db
      .prepare<[], { id: string; label: string; sort_order: number }>(
        'SELECT id, label, sort_order FROM tracks ORDER BY sort_order',
      )
      .all();

    const tracks = trackRows.map((r) => ({
      id: r.id,
      label: r.label,
      sortOrder: r.sort_order,
    }));

    // repos list: use workspace service if available; fall back to distinct repo_ids in tasks
    // The snapshot can be assembled without the workspace service by querying repos directly
    const repoRows = (this.board as unknown as { db: import('../db/index.js').Db }).db
      .prepare<[], Record<string, unknown>>('SELECT * FROM repos ORDER BY label')
      .all();

    const repoList = repoRows.map(rowToRepo);

    return {
      repos: repoList,
      pillars,
      labels,
      tracks,
      tasks,
      missions,
      savedViews,
      uiState,
    };
  }
}
