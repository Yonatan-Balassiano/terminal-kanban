import { spawnSync } from 'child_process';

export async function openExternalUrl(url: string): Promise<void> {
  const platform = process.platform;

  if (platform === 'darwin') {
    const result = spawnSync('open', [url], { stdio: 'ignore' });
    if (result.status !== 0) {
      throw new Error(result.error?.message ?? 'Failed to open URL with open');
    }
    return;
  }

  if (platform === 'linux') {
    const result = spawnSync('xdg-open', [url], { stdio: 'ignore' });
    if (result.status !== 0) {
      throw new Error(result.error?.message ?? 'Failed to open URL with xdg-open');
    }
    return;
  }

  if (platform === 'win32') {
    const result = spawnSync('cmd', ['/c', 'start', '', url], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(result.error?.message ?? 'Failed to open URL with start');
    }
    return;
  }

  throw new Error(`Unsupported platform for browser open: ${platform}`);
}
