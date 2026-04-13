import { Box, Text } from 'ink';
import { Badge, UI_CHROME } from './chrome.js';

interface Section {
  title: string;
  items: string[];
}

const SECTIONS: Section[] = [
  {
    title: 'Navigation',
    items: [
      'hjkl / arrow keys move between columns and tasks',
      ': or Ctrl+P opens the command palette',
      'Enter opens the selected task shell',
      't focuses the terminal pane',
      'z expands the terminal workspace',
    ],
  },
  {
    title: 'Task',
    items: [
      'n new task, r rename, Ctrl+D edit description, d delete, a archive',
      'p assign pillar, P create pillar, D delete pillar and its tasks',
      '[ and ] move the selected task between tracks',
      'i opens IDE, x reveals workspace, R recreates the task shell',
    ],
  },
  {
    title: 'GitHub',
    items: [
      'c create PR, o open PR, v open checks, m merge approved passing PR',
      's runs a sync for PR, CI, and review status',
    ],
  },
  {
    title: 'Views',
    items: [
      'f opens filters, g changes board / terminal layout',
      ', and . switch active repo, ? toggles this help',
    ],
  },
  {
    title: 'Terminal',
    items: [
      'Ctrl+C interrupts the running command inside the terminal',
      'PgUp/PgDn or Shift+Up/Down scroll terminal history',
      'Esc returns focus to the board',
    ],
  },
];

export function HelpOverlay(): JSX.Element {
  return (
    <Box
      borderStyle="double"
      borderColor={UI_CHROME.accent}
      padding={1}
      flexDirection="column"
      alignSelf="center"
      width={72}
    >
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Badge label="KEYBOARD" tone="accent" />
        <Text color={UI_CHROME.muted}>Esc close</Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold color={UI_CHROME.text}>
          AgentBoard workspace shortcuts
        </Text>
      </Box>

      {SECTIONS.map((section) => (
        <Box key={section.title} flexDirection="column" marginBottom={1}>
          <Box marginBottom={1}>
            <Badge label={section.title.toUpperCase()} tone="muted" />
          </Box>
          {section.items.map((item) => (
            <Text key={item} color={UI_CHROME.text} wrap="truncate">
              {`- ${item}`}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
