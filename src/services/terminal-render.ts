import headlessPkg from '@xterm/headless';
import type { IBuffer, IBufferCell } from '@xterm/headless';
import type { GetBufferResult } from '../types/index.js';

const { Terminal } = headlessPkg;

const SNAPSHOT_SCROLLBACK_LINES = 2000;
const DEFAULT_CURSOR_FOREGROUND = 0;
const DEFAULT_CURSOR_BACKGROUND = 7;

type TerminalInstance = InstanceType<typeof Terminal>;

interface TerminalColor {
  mode: 'palette' | 'rgb';
  value: number;
}

interface TerminalStyle {
  fg?: TerminalColor;
  bg?: TerminalColor;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
}

const DEFAULT_STYLE: TerminalStyle = {
  fg: undefined,
  bg: undefined,
  bold: false,
  italic: false,
  dim: false,
  underline: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
};

function cloneDefaultStyle(): TerminalStyle {
  return { ...DEFAULT_STYLE };
}

function colorKey(color: TerminalColor | undefined): string {
  if (!color) return 'default';
  return `${color.mode}:${color.value}`;
}

function styleKey(style: TerminalStyle): string {
  return [
    colorKey(style.fg),
    colorKey(style.bg),
    style.bold ? 'b' : '',
    style.italic ? 'i' : '',
    style.dim ? 'd' : '',
    style.underline ? 'u' : '',
    style.blink ? 'k' : '',
    style.inverse ? 'v' : '',
    style.invisible ? 'n' : '',
    style.strikethrough ? 's' : '',
    style.overline ? 'o' : '',
  ].join('|');
}

function isDefaultStyle(style: TerminalStyle): boolean {
  return styleKey(style) === styleKey(DEFAULT_STYLE);
}

function getCellText(cell: IBufferCell | undefined): string {
  if (!cell) {
    return '';
  }

  if (cell.getWidth() === 0) {
    return '';
  }

  return cell.getChars();
}

function readTerminalColor(
  cell: IBufferCell,
  target: 'fg' | 'bg',
): TerminalColor | undefined {
  if (target === 'fg') {
    if (cell.isFgDefault()) {
      return undefined;
    }
    if (cell.isFgPalette()) {
      return { mode: 'palette', value: cell.getFgColor() };
    }
    if (cell.isFgRGB()) {
      return { mode: 'rgb', value: cell.getFgColor() };
    }
    return undefined;
  }

  if (cell.isBgDefault()) {
    return undefined;
  }
  if (cell.isBgPalette()) {
    return { mode: 'palette', value: cell.getBgColor() };
  }
  if (cell.isBgRGB()) {
    return { mode: 'rgb', value: cell.getBgColor() };
  }
  return undefined;
}

function getCellStyle(cell: IBufferCell | undefined, cursorActive: boolean): TerminalStyle {
  if (!cell) {
    if (cursorActive) {
      return {
        ...cloneDefaultStyle(),
        fg: { mode: 'palette', value: DEFAULT_CURSOR_FOREGROUND },
        bg: { mode: 'palette', value: DEFAULT_CURSOR_BACKGROUND },
        bold: true,
      };
    }
    return cloneDefaultStyle();
  }

  if (cursorActive) {
    return {
      fg: { mode: 'palette', value: DEFAULT_CURSOR_FOREGROUND },
      bg: { mode: 'palette', value: DEFAULT_CURSOR_BACKGROUND },
      bold: true,
      italic: false,
      dim: false,
      underline: false,
      blink: false,
      inverse: false,
      invisible: false,
      strikethrough: false,
      overline: false,
    };
  }

  return {
    fg: cell.isInverse()
      ? readTerminalColor(cell, 'bg') ?? readTerminalColor(cell, 'fg')
      : readTerminalColor(cell, 'fg'),
    bg: undefined,
    bold: Boolean(cell.isBold()),
    italic: Boolean(cell.isItalic()),
    dim: Boolean(cell.isDim()),
    underline: Boolean(cell.isUnderline()),
    blink: Boolean(cell.isBlink()),
    inverse: false,
    invisible: Boolean(cell.isInvisible()),
    strikethrough: Boolean(cell.isStrikethrough()),
    overline: Boolean(cell.isOverline()),
  };
}

function colorCodes(color: TerminalColor, target: 'fg' | 'bg'): string[] {
  const prefix = target === 'fg' ? '38' : '48';
  if (color.mode === 'palette') {
    return [prefix, '5', String(color.value)];
  }

  const red = (color.value >> 16) & 0xff;
  const green = (color.value >> 8) & 0xff;
  const blue = color.value & 0xff;
  return [prefix, '2', String(red), String(green), String(blue)];
}

function ansiPrefix(style: TerminalStyle): string {
  if (isDefaultStyle(style)) {
    return '';
  }

  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.blink) codes.push('5');
  if (style.inverse) codes.push('7');
  if (style.invisible) codes.push('8');
  if (style.strikethrough) codes.push('9');
  if (style.overline) codes.push('53');
  if (style.fg) codes.push(...colorCodes(style.fg, 'fg'));
  if (style.bg) codes.push(...colorCodes(style.bg, 'bg'));

  return codes.length > 0 ? `\u001b[${codes.join(';')}m` : '';
}

function getLineEndIndex(
  line: ReturnType<IBuffer['getLine']>,
  cursorX: number,
  isCursorLine: boolean,
): number {
  if (!line) {
    return isCursorLine ? Math.max(0, cursorX) : -1;
  }

  let endIndex = isCursorLine ? Math.max(0, cursorX) : -1;
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    const text = getCellText(cell);
    if (text.length === 0) {
      continue;
    }

    const isVisibleText = text.trim().length > 0;
    if (isVisibleText) {
      endIndex = Math.max(endIndex, x);
    }
  }

  return endIndex;
}

function trimTrailingEmptyLines(buffer: GetBufferResult): GetBufferResult {
  const lastVisibleLine = Math.max(
    buffer.cursorY,
    buffer.lines.reduce((lastIndex, line, index) => {
      return line.length > 0 ? index : lastIndex;
    }, -1),
  );

  const sliceEnd = Math.max(1, lastVisibleLine + 1);
  return {
    ...buffer,
    lines: buffer.lines.slice(0, sliceEnd),
    ansiLines: buffer.ansiLines.slice(0, sliceEnd),
  };
}

export function extractTerminalBufferSnapshot(
  buffer: IBuffer,
  cursorX: number,
  cursorY: number,
): GetBufferResult {
  const lines: string[] = [];
  const ansiLines: string[] = [];

  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    const isCursorLine = y === cursorY;
    const endIndex = getLineEndIndex(line, cursorX, isCursorLine);

    if (endIndex < 0) {
      lines.push('');
      ansiLines.push('');
      continue;
    }

    let plainLine = '';
    let ansiLine = '';
    let activeStyle = cloneDefaultStyle();

    for (let x = 0; x <= endIndex; x += 1) {
      const cell = line?.getCell(x);
      const isCursorCell = isCursorLine && x === cursorX;
      const text = getCellText(cell);
      if (text.length === 0 && cell?.getWidth() === 0 && !isCursorCell) {
        continue;
      }

      const renderedText = isCursorCell
        ? (text.length === 0 ? ' ' : text)
        : (text.length === 0 ? ' ' : text);

      plainLine += renderedText;

      const nextStyle = getCellStyle(cell, isCursorCell);
      if (styleKey(nextStyle) !== styleKey(activeStyle)) {
        if (!isDefaultStyle(activeStyle)) {
          ansiLine += '\u001b[0m';
        }
        ansiLine += ansiPrefix(nextStyle);
        activeStyle = nextStyle;
      }

      ansiLine += renderedText;
    }

    if (!isDefaultStyle(activeStyle)) {
      ansiLine += '\u001b[0m';
    }

    lines.push(plainLine);
    ansiLines.push(ansiLine);
  }

  return trimTrailingEmptyLines({
    lines,
    ansiLines,
    cursorX,
    cursorY,
  });
}

export async function renderAnsiCapture(
  capture: string,
  cols: number,
  rows: number,
  cursorX: number,
  cursorY: number,
): Promise<GetBufferResult> {
  const terminal: TerminalInstance = new Terminal({
    cols: Math.max(cols, 20),
    rows: Math.max(rows, 5),
    scrollback: SNAPSHOT_SCROLLBACK_LINES,
    allowProposedApi: true,
  });

  try {
    await new Promise<void>((resolve) => {
      terminal.write(capture, () => resolve());
    });

    return extractTerminalBufferSnapshot(terminal.buffer.active, cursorX, cursorY);
  } finally {
    terminal.dispose();
  }
}
