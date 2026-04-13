import type { BoardSnapshot, FilterModel, TaskRecord } from '../types/index.js';
import type { BoardService } from './board.js';

export class ViewService {
  constructor(private board: BoardService) {}

  applyFilter(tasks: TaskRecord[], filter: FilterModel): TaskRecord[] {
    return tasks.filter((task) => {
      // includeArchived: exclude archived tasks unless explicitly requested
      if (!filter.includeArchived && task.archivedAt !== undefined) {
        return false;
      }

      // repoIds
      if (filter.repoIds && filter.repoIds.length > 0) {
        if (!filter.repoIds.includes(task.repoId)) return false;
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

    const repoList = repoRows.map((r) => ({
      id: r['id'] as string,
      label: r['label'] as string,
      path: r['path'] as string,
      githubOwner: (r['github_owner'] as string | null) ?? undefined,
      githubRepo: (r['github_repo'] as string | null) ?? undefined,
      githubUrl:
        ((r['github_url'] as string | null) ??
          (((r['github_owner'] as string | null) != null &&
            (r['github_repo'] as string | null) != null)
            ? `https://github.com/${r['github_owner'] as string}/${r['github_repo'] as string}`
            : null)) ??
        undefined,
      defaultBaseBranch: (r['default_base_branch'] as string) ?? 'main',
      defaultPillarId: (r['default_pillar_id'] as string | null) ?? undefined,
      preferredIde: (r['preferred_ide'] as import('../types/index.js').PreferredIDE | null) ?? undefined,
      ideCommand: (r['ide_command'] as string | null) ?? undefined,
      worktreeMode: (r['worktree_mode'] as import('../types/index.js').WorktreeMode | null) ?? 'auto',
      worktreeRoot: (r['worktree_root'] as string | null) ?? undefined,
      health: r['health'] as import('../types/index.js').RepoHealth,
      createdAt: r['created_at'] as number,
      updatedAt: r['updated_at'] as number,
    }));

    return {
      repos: repoList,
      pillars,
      labels,
      tracks,
      tasks,
      savedViews,
      uiState,
    };
  }
}
