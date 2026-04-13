// ============================================================
// AgentBoard — HelpOverlay component
// ============================================================

import { Box, Text } from 'ink';

interface Section {
  title: string;
  items: string[];
}

const SECTIONS: Section[] = [
  {
    title: 'Navigation',
    items: [
      'hjkl / arrow keys — move between columns and tasks',
    ],
  },
  {
    title: 'Task actions',
    items: [
      'n   — create new task',
      'i   — open selected task workspace in IDE',
      'x   — open selected task workspace in Finder/File Explorer',
      'c   — create PR for selected task',
      'o   — open GitHub PR for selected task',
      'v   — open GitHub checks for selected task PR',
      'm   — merge approved PR with passing build',
      'R   — recreate selected task shell',
      'P   — create pillar',
      'D   — delete selected task pillar and its tasks',
      'Ctrl+D — edit task description',
      'r   — rename task',
      'd   — delete task',
      'z   — open terminal full page',
      '[   — move task left (previous track)',
      ']   — move task right (next track)',
      'p   — assign pillar (c create, d delete inside picker)',
    ],
  },
  {
    title: 'View',
    items: [
      'f   — open repo/pillar filters',
      '/   — search',
      'g   — choose terminal layout (side-by-side / top-bottom)',
      ',   — switch to previous repo',
      '.   — switch to next repo',
    ],
  },
  {
    title: 'Session',
    items: [
      'Enter — open task shell',
      't     — focus terminal pane',
      'Ctrl+C — interrupt running terminal command',
      'PgUp/PgDn — scroll terminal output',
      'Esc   — return to board from terminal',
      'a     — pick agent macro',
    ],
  },
  {
    title: 'Sync',
    items: [
      's — manual sync (GitHub PR/CI status)',
    ],
  },
  {
    title: 'Icons',
    items: [
      '▶  selected task',
      '●  session active',
      '○  no session',
      '↑  PR open',
      '⇑  PR merged',
      '◐  CI pending',
      '✓  CI pass',
      '✗  CI fail',
    ],
  },
];

export function HelpOverlay(): JSX.Element {
  return (
    <Box
      borderStyle="double"
      padding={1}
      flexDirection="column"
      alignSelf="center"
    >
      <Box marginBottom={1}>
        <Text bold>{'AgentBoard — Keyboard Reference'}</Text>
      </Box>

      {SECTIONS.map((section) => (
        <Box key={section.title} flexDirection="column" marginBottom={1}>
          <Text bold color="cyan">
            {section.title}
          </Text>
          {section.items.map((item) => (
            <Text key={item}>{`  ${item}`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
