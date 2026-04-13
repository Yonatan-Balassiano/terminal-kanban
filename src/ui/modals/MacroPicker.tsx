// ============================================================
// AgentBoard — MacroPickerModal
// ============================================================

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentMacro } from '../../types/index.js';

export interface MacroPickerProps {
  macros: AgentMacro[];
  onSelect: (macro: AgentMacro) => void;
  onCancel: () => void;
}

export function MacroPickerModal(props: MacroPickerProps): JSX.Element {
  const { macros, onSelect, onCancel } = props;

  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const macro = macros[index];
      if (macro != null) {
        onSelect(macro);
      }
      return;
    }

    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setIndex((i) => Math.min(macros.length - 1, i + 1));
      return;
    }
  });

  if (macros.length === 0) {
    return (
      <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
        <Text bold>{'Agent Macros'}</Text>
        <Text dimColor>{'No macros configured.'}</Text>
        <Text dimColor>{'[Esc] cancel'}</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" padding={1} flexDirection="column" gap={1}>
      <Text bold>{'Agent Macros'}</Text>

      {macros.map((macro, idx) => (
        <Box key={macro.id} flexDirection="row" gap={1}>
          <Text color={idx === index ? 'green' : undefined}>
            {idx === index ? '▶' : ' '}
          </Text>
          <Text color={idx === index ? 'green' : undefined}>
            {macro.label}
          </Text>
          {idx === index && (
            <Text dimColor>{`  ${macro.command}`}</Text>
          )}
        </Box>
      ))}

      <Text dimColor>{'↑↓ navigate  [Enter] run  [Esc] cancel'}</Text>
    </Box>
  );
}
