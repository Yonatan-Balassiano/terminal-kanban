import { describe, it, expect } from 'vitest';
import { CoderProvider, normalizeWorkspaceName } from '../src/services/remote/coder.js';
import {
  ExecError,
  type ExecOptions,
  type ExecResult,
  type ExecTransport,
  type TransportReachability,
} from '../src/services/transport/index.js';

interface RecordedCall {
  argv: string[];
  options: ExecOptions;
}

/** Stands in for the laptop running the `coder` CLI. */
class FakeTransport implements ExecTransport {
  readonly id = 'fake';
  readonly isRemote = false;
  readonly calls: RecordedCall[] = [];

  constructor(private responses: Array<string | Error>) {}

  exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ argv: [...argv], options });
    // The last response repeats, so a poll loop can settle on a final state.
    const next = this.responses.length > 1 ? this.responses.shift()! : this.responses[0];
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve({ stdout: next ?? '', stderr: '', exitCode: 0 });
  }

  async exists(): Promise<boolean> {
    return false;
  }
  async mkdirp(): Promise<void> {}
  async removeDir(): Promise<void> {}
  async writeFileIfChanged(): Promise<boolean> {
    return false;
  }
  async reachability(): Promise<TransportReachability> {
    return 'ok';
  }
}

function workspaceJson(status: string, name = 'Web5-Yonatan', owner = 'yonatanbal'): string {
  return JSON.stringify([
    { name: 'other-box', owner_name: owner, latest_build: { status: 'running' } },
    { name, owner_name: owner, latest_build: { status } },
  ]);
}

function makeProvider(responses: Array<string | Error>, workspace = 'yonatanbal/Web5-Yonatan') {
  const transport = new FakeTransport(responses);
  const provider = new CoderProvider({
    transport,
    workspace,
    now: () => 0,
    sleep: async () => {},
  });
  return { transport, provider };
}

describe('normalizeWorkspaceName', () => {
  it('converts an SSH alias into the owner/name form the CLI expects', () => {
    expect(normalizeWorkspaceName('main.Web5-Yonatan.yonatanbal.coder')).toBe(
      'yonatanbal/Web5-Yonatan'
    );
  });

  it('leaves an owner/name value untouched', () => {
    expect(normalizeWorkspaceName('yonatanbal/Web5-Yonatan')).toBe('yonatanbal/Web5-Yonatan');
  });

  it('strips a trailing agent suffix', () => {
    expect(normalizeWorkspaceName('yonatanbal/Web5-Yonatan.main')).toBe('yonatanbal/Web5-Yonatan');
  });
});

describe('CoderProvider.status', () => {
  it('reports running when the latest build is running', async () => {
    const { provider } = makeProvider([workspaceJson('running')]);
    expect(await provider.status()).toBe('running');
  });

  it('reports stopped when the latest build is stopped', async () => {
    const { provider } = makeProvider([workspaceJson('stopped')]);
    expect(await provider.status()).toBe('stopped');
  });

  it('maps pending and starting builds to starting', async () => {
    expect(await makeProvider([workspaceJson('pending')]).provider.status()).toBe('starting');
    expect(await makeProvider([workspaceJson('starting')]).provider.status()).toBe('starting');
  });

  it('reports failed when the latest build failed', async () => {
    const { provider } = makeProvider([workspaceJson('failed')]);
    expect(await provider.status()).toBe('failed');
  });

  it('matches a bare workspace name as well as owner/name', async () => {
    const { provider } = makeProvider([workspaceJson('running')], 'Web5-Yonatan');
    expect(await provider.status()).toBe('running');
  });

  it('returns unknown when the workspace is not in the list', async () => {
    const { provider } = makeProvider([workspaceJson('running', 'someone-elses-box', 'bob')]);
    expect(await provider.status()).toBe('unknown');
  });

  it('returns unknown rather than throwing on non-JSON output', async () => {
    const { provider } = makeProvider(['not json at all']);
    expect(await provider.status()).toBe('unknown');
  });

  it('returns unknown when the coder CLI is missing or errors', async () => {
    const { provider } = makeProvider([new ExecError('coder not found', 127, '', '')]);
    expect(await provider.status()).toBe('unknown');
  });

  it('asks the CLI for JSON and bounds the call', async () => {
    const { provider, transport } = makeProvider([workspaceJson('running')]);
    await provider.status();
    expect(transport.calls[0]?.argv).toEqual(['coder', 'list', '--output', 'json']);
    expect(transport.calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });
});

describe('CoderProvider.start', () => {
  it('starts the normalised workspace name', async () => {
    const transport = new FakeTransport(['']);
    const provider = new CoderProvider({
      transport,
      workspace: 'main.Web5-Yonatan.yonatanbal.coder',
    });
    await provider.start();
    expect(transport.calls[0]?.argv).toEqual(['coder', 'start', 'yonatanbal/Web5-Yonatan']);
  });
});

describe('CoderProvider.waitUntilRunning', () => {
  it('resolves true once the workspace reports running', async () => {
    const { provider } = makeProvider([workspaceJson('starting'), workspaceJson('running')]);
    expect(await provider.waitUntilRunning()).toBe(true);
  });

  it('resolves false as soon as the build fails', async () => {
    const { provider } = makeProvider([workspaceJson('failed')]);
    expect(await provider.waitUntilRunning()).toBe(false);
  });

  it('keeps polling through a transient probe failure', async () => {
    const { provider } = makeProvider([
      new ExecError('control plane hiccup', 1, '', ''),
      workspaceJson('running'),
    ]);
    expect(await provider.waitUntilRunning()).toBe(true);
  });

  it('gives up once the start timeout passes', async () => {
    const transport = new FakeTransport([workspaceJson('starting')]);
    let clock = 0;
    const provider = new CoderProvider({
      transport,
      workspace: 'yonatanbal/Web5-Yonatan',
      startTimeoutMs: 10_000,
      now: () => clock,
      // Advancing here is what walks the deadline forward.
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(await provider.waitUntilRunning()).toBe(false);
  });
});
