// ============================================================
// AgentBoard — RenameTaskModal
// ============================================================

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TaskRecord } from '../../types/index.js';

export interface RenameTaskProps {
  task: TaskRecord;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}

export function RenameTaskModal(props: RenameTaskProps): JSX.Element {
  const { task, onSubmit, onCancel } = props;

  const [value, setValue] = useState(task.title);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const title = value.trim();
      if (title.length === 0) return;
      onSubmit(title);
      return;
    }

    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }

    // Printable characters
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box
      borderStyle="round"
      padding={1}
      flexDirection="column"
      gap={1}
    >
      <Text bold>{'Rename Task'}</Text>

      <Box flexDirection="row">
        <Text color="cyan">{'Title: '}</Text>
        <Text>{`${value}|`}</Text>
      </Box>

      <Text dimColor>{'[Enter] rename  [Esc] cancel'}</Text>
    </Box>
  );
}
