import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Badge, UI_CHROME } from '../chrome.js';

export interface CommandPaletteItem {
  id: string;
  title: string;
  section: string;
  detail: string;
  shortcut?: string;
  keywords?: string[];
  disabled?: boolean;
  disabledReason?: string;
}

export interface CommandPaletteModalProps {
  commands: CommandPaletteItem[];
  onSelect: (commandId: string) => void;
  onCancel: () => void;
}

const PALETTE_WIDTH = 86;
const VISIBLE_ROWS = 8;

function getWindowStart(index: number, length: number): number {
  if (length <= VISIBLE_ROWS) {
    return 0;
  }

  const centered = index - Math.floor(VISIBLE_ROWS / 2);
  return Math.max(0, Math.min(length - VISIBLE_ROWS, centered));
}

function matchesQuery(command: CommandPaletteItem, query: string): boolean {
  if (query.length === 0) {
    return true;
  }

  const haystack = [
    command.title,
    command.section,
    command.detail,
    ...(command.keywords ?? []),
  ].join(' ').toLowerCase();

  return haystack.includes(query);
}

export function CommandPaletteModal({
  commands,
  onSelect,
  onCancel,
}: CommandPaletteModalProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCommands = useMemo(
    () => commands.filter((command) => matchesQuery(command, normalizedQuery)),
    [commands, normalizedQuery],
  );

  useEffect(() => {
    setIndex((current) => Math.max(0, Math.min(current, filteredCommands.length - 1)));
  }, [filteredCommands.length]);

  useEffect(() => {
    setIndex(0);
  }, [normalizedQuery]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const command = filteredCommands[index];
      if (command && !command.disabled) {
        onSelect(command.id);
      }
      return;
    }

    if (key.upArrow) {
      setIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setIndex((current) => Math.max(0, Math.min(filteredCommands.length - 1, current + 1)));
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      return;
    }

    if (key.ctrl || key.meta || key.tab) {
      return;
    }

    if (input.length > 0 && !key.return) {
      setQuery((current) => current + input);
    }
  });

  const windowStart = getWindowStart(index, filteredCommands.length);
  const visibleCommands = filteredCommands.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box
      borderStyle="double"
      borderColor={UI_CHROME.accent}
      width={PALETTE_WIDTH}
      padding={1}
      flexDirection="column"
      gap={1}
    >
      <Box justifyContent="space-between" overflow="hidden">
        <Box flexDirection="row" gap={1}>
          <Badge label="COMMANDS" tone="accent" />
          <Text color={UI_CHROME.muted}>Search actions and workflows</Text>
        </Box>
        <Text color={UI_CHROME.muted}>Esc close</Text>
      </Box>

      <Box
        borderStyle="round"
        borderColor={UI_CHROME.line}
        paddingX={1}
        overflow="hidden"
      >
        <Text color={query.length > 0 ? UI_CHROME.text : UI_CHROME.muted} wrap="truncate">
          {query.length > 0 ? `: ${query}` : ': Type to filter commands'}
        </Text>
      </Box>

      {filteredCommands.length === 0 ? (
        <Box
          borderStyle="round"
          borderColor={UI_CHROME.line}
          padding={1}
          flexDirection="column"
        >
          <Text color={UI_CHROME.text}>No matching commands</Text>
          <Text color={UI_CHROME.muted}>Try searching by action, workflow, or shortcut.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {visibleCommands.map((command, visibleIndex) => {
            const actualIndex = windowStart + visibleIndex;
            const isSelected = actualIndex === index;
            return (
              <Box
                key={command.id}
                flexDirection="column"
                borderStyle="round"
                borderColor={isSelected ? UI_CHROME.accent : UI_CHROME.line}
                paddingX={1}
                marginBottom={visibleIndex === visibleCommands.length - 1 ? 0 : 1}
              >
                <Box flexDirection="row" justifyContent="space-between" overflow="hidden">
                  <Box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} overflow="hidden">
                    <Text color={isSelected ? UI_CHROME.accent : UI_CHROME.muted}>
                      {isSelected ? '▸' : ' '}
                    </Text>
                    <Badge label={command.section.toUpperCase()} tone="muted" />
                    <Box flexGrow={1} flexShrink={1} overflow="hidden">
                      <Text
                        color={command.disabled ? UI_CHROME.muted : UI_CHROME.text}
                        bold={isSelected}
                        wrap="truncate"
                      >
                        {command.title}
                      </Text>
                    </Box>
                  </Box>
                  {command.shortcut && (
                    <Text color={UI_CHROME.muted}>{command.shortcut}</Text>
                  )}
                </Box>
                <Text color={command.disabled ? UI_CHROME.warning : UI_CHROME.muted} wrap="truncate">
                  {command.disabled ? command.disabledReason ?? command.detail : command.detail}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box justifyContent="space-between">
        <Text color={UI_CHROME.muted}>↑↓ move  Enter run</Text>
        <Text color={UI_CHROME.muted}>
          {filteredCommands.length > 0
            ? `${index + 1}/${filteredCommands.length}`
            : '0 results'}
        </Text>
      </Box>
    </Box>
  );
}
