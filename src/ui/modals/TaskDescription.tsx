// ============================================================
// AgentBoard — TaskDescriptionModal
// ============================================================

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TaskRecord } from '../../types/index.js';

export interface TaskDescriptionProps {
  task: TaskRecord;
  onSubmit: (description: string) => void;
  onCancel: () => void;
}

export function TaskDescriptionModal(props: TaskDescriptionProps): JSX.Element {
  const { task, onSubmit, onCancel } = props;

  const [value, setValue] = useState(task.description ?? '');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      onSubmit(value.trim());
      return;
    }

    if (key.backspace || key.delete) {
      setValue((current) => current.slice(0, -1));
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setValue((current) => current + input);
    }
  });

  return (
    <Box
      borderStyle="round"
      padding={1}
      flexDirection="column"
      gap={1}
    >
      <Text bold>{'Task Description'}</Text>

      <Text dimColor wrap="truncate">
        {task.title}
      </Text>

      <Box flexDirection="row">
        <Text color="cyan">{'Desc: '}</Text>
        <Text>{`${value}|`}</Text>
      </Box>

      <Text dimColor>{'[Enter] save  [Esc] cancel'}</Text>
    </Box>
  );
}
