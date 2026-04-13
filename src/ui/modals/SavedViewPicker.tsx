// ============================================================
// AgentBoard — SavedViewPickerModal
// ============================================================

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SavedViewRecord } from '../../types/index.js';

export interface SavedViewPickerProps {
  views: SavedViewRecord[];
  onSelect: (viewId: string) => void;
  onCancel: () => void;
}

export function SavedViewPickerModal(props: SavedViewPickerProps): JSX.Element {
  const { views, onSelect, onCancel } = props;

  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const view = views[index];
      if (view != null) {
        onSelect(view.id);
      }
      return;
    }

    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setIndex((i) => Math.min(views.length - 1, i + 1));
      return;
    }
  });

  if (views.length === 0) {
    return (
      <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
        <Text bold>{'Saved Views'}</Text>
        <Text dimColor>{'No saved views.'}</Text>
        <Text dimColor>{'[Esc] cancel'}</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
      <Text bold>{'Saved Views'}</Text>

      {views.map((view, idx) => {
        const isSelected = idx === index;
        return (
          <Box key={view.id} flexDirection="row" gap={1}>
            <Text color={isSelected ? 'green' : undefined}>
              {isSelected ? '▶' : ' '}
            </Text>
            <Text color={isSelected ? 'green' : undefined}>
              {view.label}
            </Text>
            {view.isSystem && (
              <Text dimColor>{'[system]'}</Text>
            )}
          </Box>
        );
      })}

      <Text dimColor>{'↑↓ navigate  [Enter] select  [Esc] cancel'}</Text>
    </Box>
  );
}
