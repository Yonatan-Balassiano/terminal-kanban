import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { dirname } from 'path';
import {
  LOCAL_TRANSPORT_ID,
  ExecError,
  type ExecOptions,
  type ExecResult,
  type ExecTransport,
  type TransportReachability,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Runs commands and touches files on the machine the daemon is running on. */
export class LocalTransport implements ExecTransport {
  readonly id = LOCAL_TRANSPORT_ID;
  readonly isRemote = false;

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    const [command, ...args] = argv;
    if (!command) {
      return Promise.reject(new Error('exec requires a command'));
    }

    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          env: options.env ? { ...process.env, ...options.env } : process.env,
        },
        (error, stdout, stderr) => {
          const out = String(stdout ?? '');
          const err = String(stderr ?? '');
          if (!error) {
            resolve({ stdout: out, stderr: err, exitCode: 0 });
            return;
          }
          const exitCode = typeof error.code === 'number' ? error.code : 1;
          const timedOut = Boolean((error as { killed?: boolean }).killed);
          reject(
            new ExecError(`${command} failed: ${error.message}`, exitCode, out, err, timedOut)
          );
        }
      );
    });
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }

  async mkdirp(path: string): Promise<void> {
    mkdirSync(path, { recursive: true });
  }

  async removeDir(path: string): Promise<void> {
    rmSync(path, { recursive: true, force: true });
  }

  async writeFileIfChanged(path: string, content: string, mode?: number): Promise<boolean> {
    if (existsSync(path) && readFileSync(path, 'utf8') === content) {
      return false;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    if (mode !== undefined) {
      chmodSync(path, mode);
    }
    return true;
  }

  async reachability(): Promise<TransportReachability> {
    return 'ok';
  }
}
