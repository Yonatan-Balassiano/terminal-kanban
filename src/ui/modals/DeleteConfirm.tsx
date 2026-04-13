// ============================================================
// AgentBoard — DeleteConfirmModal
// ============================================================

import { Box, Text, useInput } from 'ink';
import type { TaskRecord } from '../../types/index.js';

export interface DeleteConfirmProps {
  task: TaskRecord;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmModal(props: DeleteConfirmProps): JSX.Element {
  const { task, onConfirm, onCancel } = props;

  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onCancel();
      return;
    }

    if (input === 'y' || input === 'Y') {
      onConfirm();
      return;
    }
  });

  return (
    <Box
      borderStyle="round"
      padding={1}
      flexDirection="column"
      gap={1}
    >
      <Text bold color="red">{'Delete Task'}</Text>

      <Text>
        {"Delete task '"}
        <Text bold>{task.title}</Text>
        {"'?"}
      </Text>

      <Text dimColor>{'[y] confirm  [n/Esc] cancel'}</Text>
    </Box>
  );
}
