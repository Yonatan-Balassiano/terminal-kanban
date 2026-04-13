import type { AppState, TaskRecord, TrackRecord } from '../types/index.js';

function getVisibleBoardTasks(state: AppState): TaskRecord[] {
  let visibleTasks = state.tasks;

  if (state.activeRepoId) {
    visibleTasks = visibleTasks.filter((task) => task.repoId === state.activeRepoId);
  }
  if (state.filters.repoIds && state.filters.repoIds.length > 0) {
    visibleTasks = visibleTasks.filter((task) => state.filters.repoIds!.includes(task.repoId));
  }
  if (state.filters.pillarIds && state.filters.pillarIds.length > 0) {
    visibleTasks = visibleTasks.filter(
      (task) => task.pillarId !== undefined && state.filters.pillarIds!.includes(task.pillarId),
    );
  }
  if (state.filters.trackIds && state.filters.trackIds.length > 0) {
    visibleTasks = visibleTasks.filter((task) => state.filters.trackIds!.includes(task.trackId));
  }
  if (!state.filters.includeArchived) {
    visibleTasks = visibleTasks.filter((task) => task.archivedAt === undefined);
  }
  if (state.filters.searchText) {
    const needle = state.filters.searchText.toLowerCase();
    visibleTasks = visibleTasks.filter((task) => task.title.toLowerCase().includes(needle));
  }

  return visibleTasks;
}

function getSortedTracks(tracks: TrackRecord[]): TrackRecord[] {
  return [...tracks].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getHeaderContextTask(state: AppState): TaskRecord | undefined {
  if (state.activeTaskId) {
    return state.tasks.find((task) => task.id === state.activeTaskId);
  }

  const sortedTracks = getSortedTracks(state.tracks);
  const selectedTrack = sortedTracks[state.selectedTrackIndex];
  if (!selectedTrack) {
    return undefined;
  }

  const tasksByTrack = new Map<string, TaskRecord[]>();
  for (const track of sortedTracks) {
    tasksByTrack.set(track.id, []);
  }

  for (const task of getVisibleBoardTasks(state)) {
    const group = tasksByTrack.get(task.trackId);
    if (group) {
      group.push(task);
    }
  }

  for (const group of tasksByTrack.values()) {
    group.sort((a, b) => a.sortKey - b.sortKey);
  }

  const selectedTrackTasks = tasksByTrack.get(selectedTrack.id) ?? [];
  return selectedTrackTasks[state.selectedTaskIndex];
}
