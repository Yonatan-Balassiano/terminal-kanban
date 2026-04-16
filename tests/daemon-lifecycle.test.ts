import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { stopDaemon } from '../src/daemon/index.js';

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-daemon-'));
  tempDirs.push(dir);
  return dir;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    const pid = child.pid;
    if (pid && isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Child already exited.
      }
    }
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('stopDaemon', () => {
  it('stops the pid from daemon.pid and removes the stale socket path', async () => {
    const stateDir = makeStateDir();
    const child = spawnSleeper();
    const socketPath = path.join(stateDir, 'agentboard.sock');

    fs.writeFileSync(path.join(stateDir, 'daemon.pid'), String(child.pid), 'utf8');
    fs.writeFileSync(path.join(stateDir, 'daemon.lock'), String(child.pid), 'utf8');
    fs.writeFileSync(socketPath, '', 'utf8');

    await expect(
      stopDaemon({
        stateDir,
        socketPath,
        logFile: path.join(stateDir, 'agentboard.log'),
      }),
    ).resolves.toBe(true);

    expect(fs.existsSync(socketPath)).toBe(false);
    expect(isProcessAlive(child.pid!)).toBe(false);
  });

  it('falls back to daemon.lock when daemon.pid is missing', async () => {
    const stateDir = makeStateDir();
    const child = spawnSleeper();

    fs.writeFileSync(path.join(stateDir, 'daemon.lock'), String(child.pid), 'utf8');

    await expect(
      stopDaemon({
        stateDir,
        socketPath: path.join(stateDir, 'agentboard.sock'),
        logFile: path.join(stateDir, 'agentboard.log'),
      }),
    ).resolves.toBe(true);

    expect(isProcessAlive(child.pid!)).toBe(false);
  });
});
