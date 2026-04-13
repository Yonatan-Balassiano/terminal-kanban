// ============================================================
// AgentBoard — Board component (full kanban board)
// ============================================================

import React from 'react';
import { Box, Text } from 'ink';
import { useAppState } from '../store/index.js';
import { Track } from './Track.js';
import type { TaskRecord } from '../types/index.js';

export interface BoardProps {
  height: number;
}

export const Board = React.memo(function Board({
  height,
}: BoardProps): JSX.Element {
  const {
    repos,
    tracks,
    tasks,
    selectedTrackIndex,
    selectedTaskIndex,
    activeRepoId,
    filters,
  } = useAppState();
  const repoLabelsById = new Map(repos.map((repo) => [repo.id, repo.label]));

  // No repos registered yet
  if (repos.length === 0) {
    return (
      <Box padding={2}>
        <Text dimColor>
          No repos registered. Run: agentboard repos add &lt;path&gt;
        </Text>
      </Box>
    );
  }

  // Filter tasks by active repo / filter criteria
  let visibleTasks: TaskRecord[] = tasks;
  if (activeRepoId) {
    visibleTasks = visibleTasks.filter((t) => t.repoId === activeRepoId);
  }
  if (filters.repoIds && filters.repoIds.length > 0) {
    visibleTasks = visibleTasks.filter((t) => filters.repoIds!.includes(t.repoId));
  }
  if (filters.pillarIds && filters.pillarIds.length > 0) {
    visibleTasks = visibleTasks.filter(
      (t) => t.pillarId !== undefined && filters.pillarIds!.includes(t.pillarId),
    );
  }
  if (filters.trackIds && filters.trackIds.length > 0) {
    visibleTasks = visibleTasks.filter((t) => filters.trackIds!.includes(t.trackId));
  }
  if (!filters.includeArchived) {
    visibleTasks = visibleTasks.filter((t) => t.archivedAt === undefined);
  }
  if (filters.searchText) {
    const needle = filters.searchText.toLowerCase();
    visibleTasks = visibleTasks.filter((t) =>
      t.title.toLowerCase().includes(needle),
    );
  }

  // Sort tracks by sortOrder
  const sortedTracks = [...tracks].sort((a, b) => a.sortOrder - b.sortOrder);

  // Group tasks by trackId, sorted by sortKey within each track
  const tasksByTrack = new Map<string, TaskRecord[]>();
  for (const track of sortedTracks) {
    tasksByTrack.set(track.id, []);
  }
  for (const task of visibleTasks) {
    const group = tasksByTrack.get(task.trackId);
    if (group) {
      group.push(task);
    }
  }
  for (const group of tasksByTrack.values()) {
    group.sort((a, b) => a.sortKey - b.sortKey);
  }

  const visibleRepoIds = new Set(visibleTasks.map((task) => task.repoId));
  const showRepoLabel = visibleRepoIds.size > 1;

  return (
    <Box flexDirection="row" gap={1} height={height} overflow="hidden">
      {sortedTracks.map((track, trackIndex) => {
        const trackTasks = tasksByTrack.get(track.id) ?? [];
        const isSelected = trackIndex === selectedTrackIndex;
        return (
          <Track
            key={track.id}
            track={track}
            tasks={trackTasks}
            isSelected={isSelected}
            selectedTaskIndex={isSelected ? selectedTaskIndex : -1}
            repoLabelsById={repoLabelsById}
            showRepoLabel={showRepoLabel}
            height={height}
          />
        );
      })}
    </Box>
  );
});
