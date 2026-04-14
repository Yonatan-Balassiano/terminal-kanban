// ============================================================
// AgentBoard — ArchiveConfirmModal
// ============================================================

import { Box, Text, useInput } from 'ink';
import type { TaskRecord } from '../../types/index.js';

export interface ArchiveConfirmProps {
  task: TaskRecord;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ArchiveConfirmModal(props: ArchiveConfirmProps): JSX.Element {
  const { task, onConfirm, onCancel } = props;

  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onCancel();
      return;
    }

    if (input === 'y' || input === 'Y') {
      onConfirm();
    }
  });

  return (
    <Box
      borderStyle="round"
      padding={1}
      flexDirection="column"
      gap={1}
    >
      <Text bold color="yellow">{'Archive Task'}</Text>

      <Text>
        {"Archive task '"}
        <Text bold>{task.title}</Text>
        {"'?"}
      </Text>

      <Text dimColor>{'[y] confirm  [n/Esc] cancel'}</Text>
    </Box>
  );
}
