import { describe, expect, it } from 'vitest';
import {
  canShowTerminalPane,
  getTerminalContentWidth,
  getTerminalPaneWidth,
  MIN_TOTAL_TERMINAL_WIDTH,
} from '../src/ui/terminal-layout.js';

describe('terminal layout helpers', () => {
  it('reports the embedded terminal as hidden below the minimum width', () => {
    expect(canShowTerminalPane(MIN_TOTAL_TERMINAL_WIDTH - 1)).toBe(false);
    expect(getTerminalPaneWidth(MIN_TOTAL_TERMINAL_WIDTH - 1)).toBe(39);
  });

  it('reports the embedded terminal as usable at the minimum width', () => {
    expect(canShowTerminalPane(MIN_TOTAL_TERMINAL_WIDTH)).toBe(true);
    expect(getTerminalPaneWidth(MIN_TOTAL_TERMINAL_WIDTH)).toBe(40);
  });

  it('derives the rendered terminal content width from the live pane width', () => {
    expect(getTerminalContentWidth(MIN_TOTAL_TERMINAL_WIDTH, false)).toBe(38);
    expect(getTerminalContentWidth(120, true)).toBe(118);
  });
});
