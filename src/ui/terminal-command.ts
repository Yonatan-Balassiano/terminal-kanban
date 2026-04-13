export interface TerminalKeyLike {
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
  escape?: boolean;
  tab?: boolean;
}

export function appendTerminalInput(
  current: string,
  input: string,
  key: TerminalKeyLike,
): string {
  if (key.return || key.escape || (key.ctrl && input === 'c')) {
    return '';
  }

  if (key.backspace || key.delete) {
    return current.slice(0, -1);
  }

  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
    return current;
  }

  if (key.ctrl) {
    return current;
  }

  return current + input;
}

export function shouldTriggerTerminalPushSync(command: string, key: TerminalKeyLike): boolean {
  return key.return === true && /\bgit\s+push\b/.test(command.trim());
}
