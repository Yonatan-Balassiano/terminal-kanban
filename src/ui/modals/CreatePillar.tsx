// ============================================================
// AgentBoard — CreatePillarModal
// ============================================================

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface CreatePillarProps {
  onSubmit: (label: string) => void;
  onCancel: () => void;
}

export function CreatePillarModal(props: CreatePillarProps): JSX.Element {
  const { onSubmit, onCancel } = props;
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const label = value.trim();
      if (label.length === 0) return;
      onSubmit(label);
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
    <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
      <Text bold>{'Create Pillar'}</Text>

      <Box flexDirection="row">
        <Text color="cyan">{'Label: '}</Text>
        <Text>{`${value}|`}</Text>
      </Box>

      <Text dimColor>{'[Enter] create  [Esc] cancel'}</Text>
    </Box>
  );
}
