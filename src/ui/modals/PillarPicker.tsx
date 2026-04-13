// ============================================================
// AgentBoard — PillarPickerModal
// ============================================================

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PillarRecord } from '../../types/index.js';

export interface PillarPickerProps {
  pillars: PillarRecord[];
  currentPillarId?: string;
  onSelect: (pillarId: string | null) => void;
  onCreate: () => void;
  onDelete: (pillar: PillarRecord) => void;
  onCancel: () => void;
}

interface PillarOption {
  id: string | null;
  label: string;
  icon?: string;
}

export function PillarPickerModal(props: PillarPickerProps): JSX.Element {
  const { pillars, currentPillarId, onSelect, onCreate, onDelete, onCancel } = props;

  // "None" option at the top, then all pillars
  const options: PillarOption[] = [
    { id: null, label: 'None' },
    ...pillars.map((p) => ({ id: p.id, label: p.label, icon: p.icon })),
  ];

  const initialIndex = currentPillarId != null
    ? Math.max(0, options.findIndex((o) => o.id === currentPillarId))
    : 0;

  const [index, setIndex] = useState(initialIndex);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const option = options[index];
      if (option != null) {
        onSelect(option.id);
      }
      return;
    }

    if (input === 'c' || input === 'C') {
      onCreate();
      return;
    }

    if (input === 'd' || input === 'D') {
      const option = options[index];
      if (option?.id == null) {
        return;
      }

      const pillar = pillars.find((candidate) => candidate.id === option.id);
      if (pillar) {
        onDelete(pillar);
      }
      return;
    }

    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setIndex((i) => Math.min(options.length - 1, i + 1));
      return;
    }
  });

  return (
    <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
      <Text bold>{'Assign Pillar'}</Text>

      {options.map((option, idx) => {
        const isSelected = idx === index;
        const isCurrent = option.id === (currentPillarId ?? null);
        const displayLabel = option.icon
          ? `${option.icon} ${option.label}`
          : option.label;

        return (
          <Box key={String(option.id ?? 'none')} flexDirection="row" gap={1}>
            <Text color={isSelected ? 'green' : undefined}>
              {isSelected ? '▶' : ' '}
            </Text>
            <Text color={isSelected ? 'green' : undefined}>
              {displayLabel}
            </Text>
            {isCurrent && (
              <Text dimColor>{'(current)'}</Text>
            )}
          </Box>
        );
      })}

      <Text dimColor>{'↑↓ navigate  [Enter] select  [c] create  [d] delete  [Esc] cancel'}</Text>
    </Box>
  );
}
