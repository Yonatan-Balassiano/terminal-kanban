// ============================================================
// AgentBoard — Track component (single kanban column)
// ============================================================

import { Box, Text } from 'ink';
import type { TrackRecord, TaskRecord } from '../types/index.js';
import { useAppState } from '../store/index.js';
import { TaskCard, getTaskCardHeight } from './TaskCard.js';
import { getVisibleWindow } from './track-window.js';

export interface TrackProps {
  track: TrackRecord;
  tasks: TaskRecord[];
  isSelected: boolean;
  selectedTaskIndex: number;
  repoLabelsById: Map<string, string>;
  height: number;
}

const COLUMN_WIDTH = 32;
const TRACK_FRAME_HEIGHT = 3;

export function Track({
  track,
  tasks,
  isSelected,
  selectedTaskIndex,
  repoLabelsById,
  height,
}: TrackProps): JSX.Element {
  const { pillars, focus, activeTaskId } = useAppState();
  const boardFocused = focus === 'board' || focus === 'filterbar';
  const showSelection = boardFocused && isSelected;

  const headerLabel = `${track.label} (${tasks.length})`;
  const listHeight = Math.max(1, height - TRACK_FRAME_HEIGHT);
  const taskHeights = tasks.map((task) =>
    getTaskCardHeight(task, pillars.some((pillar) => pillar.id === task.pillarId)),
  );
  const { start, end } = getVisibleWindow(
    taskHeights,
    isSelected ? selectedTaskIndex : 0,
    listHeight,
  );
  const visibleTasks = tasks.slice(start, end);

  return (
    <Box
      flexDirection="column"
      width={COLUMN_WIDTH}
      height={height}
      borderStyle="single"
      borderColor={showSelection ? 'cyan' : 'gray'}
      overflow="hidden"
    >
      {/* Column header */}
      <Box paddingX={1}>
        <Text
          bold
          color={showSelection ? 'cyan' : 'white'}
          underline={showSelection}
        >
          {headerLabel}
        </Text>
      </Box>

      {/* Task list */}
      {tasks.length === 0 ? (
        <Box paddingX={1} paddingY={1}>
          <Text dimColor>No tasks</Text>
        </Box>
      ) : (
        <Box flexDirection="column" overflow="hidden">
          {visibleTasks.map((task, index) => {
            const actualIndex = start + index;
            return (
              <TaskCard
                key={task.id}
                task={task}
                isSelected={showSelection && actualIndex === selectedTaskIndex}
                isActiveSession={activeTaskId === task.id}
                pillars={pillars}
                repoLabel={repoLabelsById.get(task.repoId) ?? task.repoId}
              />
            );
          })}
        </Box>
      )}
    </Box>
  );
}
