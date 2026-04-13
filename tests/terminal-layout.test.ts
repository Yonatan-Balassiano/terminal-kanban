import { describe, expect, it } from 'vitest';
import {
  canShowTerminalPane,
  getTerminalContentWidth,
  getTerminalPaneWidth,
  getTerminalViewportHeight,
  MIN_TOTAL_TERMINAL_WIDTH,
  shouldShowTerminalFooter,
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
    expect(getTerminalContentWidth(MIN_TOTAL_TERMINAL_WIDTH, false)).toBe(40);
    expect(getTerminalContentWidth(120, true)).toBe(120);
  });

  it('reserves terminal chrome lines for the session header and footer', () => {
    expect(getTerminalViewportHeight(10)).toBe(8);
    expect(getTerminalViewportHeight(2)).toBe(1);
    expect(shouldShowTerminalFooter(3)).toBe(true);
    expect(shouldShowTerminalFooter(2)).toBe(false);
  });
});
