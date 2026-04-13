import headlessPkg from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import {
  extractTerminalBufferSnapshot,
  renderAnsiCapture,
} from '../src/services/terminal-render.js';

const { Terminal } = headlessPkg;

describe('terminal render snapshot', () => {
  it('preserves ANSI colors and formatting from the xterm buffer', async () => {
    const terminal = new Terminal({
      cols: 40,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
    });

    await new Promise<void>((resolve) => {
      terminal.write('\u001b[38;5;208morange\u001b[0m \u001b[48;2;1;2;3mBG\u001b[0m', () => resolve());
    });

    const snapshot = extractTerminalBufferSnapshot(
      terminal.buffer.active,
      2,
      0,
    );

    expect(snapshot.lines[0]).toBe('orange BG');
    expect(snapshot.ansiLines[0]).toContain('\u001b[38;5;208m');
    expect(snapshot.ansiLines[0]).not.toContain('\u001b[48;2;1;2;3m');

    terminal.dispose();
  });

  it('renders a visible cursor highlight into styled lines', async () => {
    const terminal = new Terminal({
      cols: 40,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
    });

    await new Promise<void>((resolve) => {
      terminal.write('prompt', () => resolve());
    });

    const snapshot = extractTerminalBufferSnapshot(terminal.buffer.active, 0, 0);

    expect(snapshot.lines[0][0]).toBe('p');
    expect(snapshot.ansiLines[0]).toContain('\u001b[1;38;5;0;48;5;7mp');

    terminal.dispose();
  });

  it('renders a block cursor on blank cells', async () => {
    const terminal = new Terminal({
      cols: 10,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
    });

    await new Promise<void>((resolve) => {
      terminal.write('> ', () => resolve());
    });

    const snapshot = extractTerminalBufferSnapshot(
      terminal.buffer.active,
      terminal.buffer.active.cursorX,
      terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    );

    expect(snapshot.lines[0]).toBe('>  ');
    expect(snapshot.ansiLines[0]).toContain('\u001b[1;38;5;0;48;5;7m ');

    terminal.dispose();
  });

  it('rebuilds styled lines from tmux capture output', async () => {
    const snapshot = await renderAnsiCapture(
      '\u001b[31mred\u001b[0m plain',
      40,
      10,
      4,
      0,
    );

    expect(snapshot.lines[0]).toBe('red plain');
    expect(snapshot.ansiLines[0]).toContain('\u001b[38;5;1m');
  });

  it('preserves internal blank cells for right-aligned prompt content', async () => {
    const terminal = new Terminal({
      cols: 24,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
    });

    await new Promise<void>((resolve) => {
      terminal.write('left\u001b[17G14:07:57', () => resolve());
    });

    const snapshot = extractTerminalBufferSnapshot(
      terminal.buffer.active,
      terminal.buffer.active.cursorX,
      terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    );

    expect(snapshot.lines[0]).toBe('left            14:07:57 ');

    terminal.dispose();
  });

  it('does not surface background-only blank rows as visible content', async () => {
    const terminal = new Terminal({
      cols: 20,
      rows: 5,
      scrollback: 100,
      allowProposedApi: true,
    });

    await new Promise<void>((resolve) => {
      terminal.write('\u001b[48;5;7m          \u001b[0m', () => resolve());
    });

    const snapshot = extractTerminalBufferSnapshot(terminal.buffer.active, 0, 0);

    expect(snapshot.lines).toEqual([' ']);
    expect(snapshot.ansiLines[0]).toContain('\u001b[1;38;5;0;48;5;7m ');

    terminal.dispose();
  });

  it('drops non-cursor background colors from styled output', async () => {
    const snapshot = await renderAnsiCapture(
      '\u001b[48;5;7mgray-bg\u001b[0m',
      40,
      10,
      7,
      0,
    );

    expect(snapshot.ansiLines[0]).not.toContain('\u001b[48;5;7mgray-bg');
  });
});
