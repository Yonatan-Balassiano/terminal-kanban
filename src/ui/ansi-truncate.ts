import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';

const ANSI_ESCAPE = '\u001b';

function appendResetIfStyled(line: string, sawAnsi: boolean): string {
  if (!sawAnsi || /\u001b\[[0-9;]*m$/.test(line)) {
    return line;
  }

  return `${line}${ANSI_ESCAPE}[0m`;
}

export function truncatePlain(line: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }

  if (stringWidth(line) <= maxWidth) {
    return line;
  }

  return sliceAnsi(line, 0, maxWidth);
}

export function truncateAnsi(line: string, maxWidth: number): string {
  if (maxWidth <= 0 || line.length === 0) {
    return '';
  }
  if (stringWidth(line) <= maxWidth) {
    return line;
  }

  const result = sliceAnsi(line, 0, maxWidth);
  const sawAnsi = line.includes(`${ANSI_ESCAPE}[`);
  return appendResetIfStyled(result, sawAnsi);
}
