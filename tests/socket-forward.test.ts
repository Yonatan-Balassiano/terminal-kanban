import { describe, expect, it, vi } from 'vitest';
import { SocketForward, type ForwardProcess } from '../src/services/transport/socket-forward.js';

const REMOTE = '/home/coder/.agentboard/run/daemon.sock';
const FAST = { initialBackoffMs: 5, maxBackoffMs: 10, verifyAttempts: 3, verifyIntervalMs: 5, recheckIntervalMs: 0 };

class FakeProcess implements ForwardProcess {
  killed = false;
  private listeners: Array<(code: number | null, stderr: string) => void> = [];
  constructor(readonly args: string[]) {}
  onExit(listener: (code: number | null, stderr: string) => void) {
    this.listeners.push(listener);
  }
  kill() {
    this.killed = true;
    this.exit(null, '');
  }
  exit(code: number | null, stderr: string) {
    for (const listener of this.listeners.splice(0)) listener(code, stderr);
  }
}

function harness(opts: { bound?: () => boolean } = {}) {
  const processes: FakeProcess[] = [];
  const execs: string[][] = [];
  const forward = new SocketForward({
    host: 'test.host',
    localSocket: '/tmp/local/rpc.sock',
    remoteExec: async (argv) => {
      execs.push(argv);
      if (argv[0] === 'test' && !(opts.bound ?? (() => true))()) {
        throw new Error('exit 1');
      }
    },
    spawnForward: (args) => {
      const process = new FakeProcess(args);
      processes.push(process);
      return process;
    },
    timing: FAST,
  });
  return { forward, processes, execs };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 2_000, interval: 5 });

describe('SocketForward', () => {
  it('prepares a private dir, forwards the socket on its own connection, and checks the bind', async () => {
    const { forward, processes, execs } = harness();

    forward.ensure(REMOTE);
    await until(() => forward.getStatus().state === 'up');

    expect(execs[0]).toEqual(['sh', '-c', 'mkdir -p "$1" && chmod 700 "$1"', 'sh', '/home/coder/.agentboard/run']);
    expect(processes).toHaveLength(1);
    expect(processes[0]!.args).toEqual(expect.arrayContaining(['-N', '-R', `${REMOTE}:/tmp/local/rpc.sock`, 'test.host']));
    expect(processes[0]!.args.join(' ')).toContain('ControlPath=none');
    expect(execs).toContainEqual(['test', '-S', REMOTE]);
  });

  it('is idempotent while up', async () => {
    const { forward, processes } = harness();
    forward.ensure(REMOTE);
    await until(() => forward.getStatus().state === 'up');

    forward.ensure(REMOTE);
    forward.ensure(REMOTE);
    expect(processes).toHaveLength(1);
  });

  it('relaunches when the connection drops — a workspace restart, a lost VPN', async () => {
    const { forward, processes } = harness();
    forward.ensure(REMOTE);
    await until(() => forward.getStatus().state === 'up');

    processes[0]!.exit(255, 'Connection closed by remote host');
    await until(() => processes.length === 2 && forward.getStatus().state === 'up');
    expect(forward.getStatus().launches).toBe(2);
  });

  it('restarts a forward whose socket disappeared under a live process', async () => {
    let bound = true;
    const { forward, processes } = harness({ bound: () => bound });
    forward.ensure(REMOTE);
    await until(() => forward.getStatus().state === 'up');

    bound = false;
    forward.ensure(REMOTE);
    await until(() => processes[0]!.killed);
    bound = true;
    await until(() => processes.length === 2 && forward.getStatus().state === 'up');
  });

  it('gives up after repeated failures until asked again', async () => {
    const { forward, processes } = harness({ bound: () => false });
    forward.ensure(REMOTE);
    await until(() => processes.length === 5 && forward.getStatus().state === 'down');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(processes).toHaveLength(5);
    expect(forward.getStatus().lastError).toContain('never appeared');

    forward.ensure(REMOTE);
    await until(() => processes.length === 6);
    forward.stop();
  });

  it('stops for good', async () => {
    const { forward, processes } = harness();
    forward.ensure(REMOTE);
    await until(() => forward.getStatus().state === 'up');

    forward.stop();
    expect(processes[0]!.killed).toBe(true);
    expect(forward.getStatus().state).toBe('stopped');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(processes).toHaveLength(1);
  });
});
