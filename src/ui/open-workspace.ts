import { spawnSync } from 'child_process';
import type { PreferredIDE } from '../types/index.js';

function runOrThrow(command: string, args: string[], useShell = false): void {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    shell: useShell,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message ?? `Failed to launch: ${command}`);
  }
}

function tryLaunch(command: string, args: string[], useShell = false): boolean {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    shell: useShell,
    windowsHide: true,
  });
  return result.status === 0;
}

export async function revealPathInFileManager(targetPath: string): Promise<void> {
  const platform = process.platform;
  if (platform === 'darwin') {
    runOrThrow('open', [targetPath]);
    return;
  }
  if (platform === 'linux') {
    runOrThrow('xdg-open', [targetPath]);
    return;
  }
  if (platform === 'win32') {
    runOrThrow('cmd', ['/c', 'start', '', targetPath]);
    return;
  }

  throw new Error(`Unsupported platform for file manager open: ${platform}`);
}

export async function openPathInIDE(
  targetPath: string,
  preferredIde?: PreferredIDE,
  ideCommand?: string,
): Promise<void> {
  if (ideCommand) {
    runOrThrow(ideCommand, [targetPath], true);
    return;
  }

  const platform = process.platform;
  const order: PreferredIDE[] = preferredIde
    ? [preferredIde]
    : ['webstorm', 'idea', 'cursor', 'vscode', 'system'];

  for (const ide of order) {
    if (ide === 'system') {
      await revealPathInFileManager(targetPath);
      return;
    }

    if (platform === 'darwin') {
      if (ide === 'webstorm' && (tryLaunch('webstorm', [targetPath]) || tryLaunch('open', ['-na', 'WebStorm.app', '--args', targetPath]))) {
        return;
      }
      if (ide === 'idea' && (tryLaunch('idea', [targetPath]) || tryLaunch('open', ['-na', 'IntelliJ IDEA.app', '--args', targetPath]))) {
        return;
      }
      if (ide === 'cursor' && (tryLaunch('cursor', [targetPath]) || tryLaunch('open', ['-na', 'Cursor.app', '--args', targetPath]))) {
        return;
      }
      if (ide === 'vscode' && (tryLaunch('code', [targetPath]) || tryLaunch('open', ['-na', 'Visual Studio Code.app', '--args', targetPath]))) {
        return;
      }
      continue;
    }

    if (ide === 'webstorm' && tryLaunch('webstorm', [targetPath])) return;
    if (ide === 'idea' && tryLaunch('idea', [targetPath])) return;
    if (ide === 'cursor' && tryLaunch('cursor', [targetPath])) return;
    if (ide === 'vscode' && tryLaunch('code', [targetPath])) return;
  }

  throw new Error('No supported IDE launcher was available');
}
