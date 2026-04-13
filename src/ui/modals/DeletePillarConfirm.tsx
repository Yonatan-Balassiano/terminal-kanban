// ============================================================
// AgentBoard — DeletePillarConfirmModal
// ============================================================

import { Box, Text, useInput } from 'ink';
import type { PillarRecord } from '../../types/index.js';

export interface DeletePillarConfirmProps {
  pillar: PillarRecord;
  taskCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeletePillarConfirmModal(props: DeletePillarConfirmProps): JSX.Element {
  const { pillar, taskCount, onConfirm, onCancel } = props;

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
    <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
      <Text bold color="red">{'Delete Pillar'}</Text>

      <Text>
        {"Delete pillar '"}
        <Text bold>{pillar.label}</Text>
        {"'?"}
      </Text>

      <Text color="red">
        {`This will also delete ${taskCount} task${taskCount === 1 ? '' : 's'} in this pillar.`}
      </Text>

      <Text dimColor>{'[y] confirm  [n/Esc] cancel'}</Text>
    </Box>
  );
}
