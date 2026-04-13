import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TerminalLayoutMode } from '../../types/index.js';

const OPTIONS: Array<{ mode: TerminalLayoutMode; label: string; description: string }> = [
  {
    mode: 'side-by-side',
    label: 'Side By Side',
    description: 'Board on the left, terminal on the right',
  },
  {
    mode: 'top-bottom',
    label: 'Top / Bottom',
    description: 'Board on top, terminal on the bottom',
  },
];

export interface ViewOptionsModalProps {
  currentMode: TerminalLayoutMode;
  onSelect: (mode: TerminalLayoutMode) => void;
  onCancel: () => void;
}

export function ViewOptionsModal({
  currentMode,
  onSelect,
  onCancel,
}: ViewOptionsModalProps): JSX.Element {
  const [index, setIndex] = useState(() => {
    const currentIndex = OPTIONS.findIndex((option) => option.mode === currentMode);
    return currentIndex >= 0 ? currentIndex : 0;
  });

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      onSelect(OPTIONS[index]?.mode ?? 'side-by-side');
      return;
    }

    if (key.upArrow || key.leftArrow) {
      setIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow || key.rightArrow) {
      setIndex((current) => Math.min(OPTIONS.length - 1, current + 1));
    }
  });

  return (
    <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
      <Text bold>{'View Layout'}</Text>

      {OPTIONS.map((option, optionIndex) => {
        const isSelected = optionIndex === index;
        return (
          <Box key={option.mode} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▸' : ' '}</Text>
              <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                {option.label}
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>{option.description}</Text>
            </Box>
          </Box>
        );
      })}

      <Text dimColor>{'[↑/↓] choose  [Enter] apply  [Esc] cancel'}</Text>
    </Box>
  );
}
