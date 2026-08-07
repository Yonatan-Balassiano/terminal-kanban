import { describe, it, expect } from 'vitest';
import { SshTransport, buildControlPath } from '../src/services/transport/ssh.js';
import {
  ExecError,
  TransportUnreachableError,
  SSH_TRANSPORT_EXIT_CODE,
  type ExecOptions,
  type ExecResult,
  type ExecTransport,
} from '../src/services/transport/types.js';

interface RecordedCall {
  argv: string[];
  options: ExecOptions | undefined;
}

/** Stand-in for the local `ssh` process, capturing argv instead of running it. */
class FakeRunner implements ExecTransport {
  readonly id = 'fake';
  readonly isRemote = false;
  readonly calls: RecordedCall[] = [];

  constructor(private responder: (argv: readonly string[]) => ExecResult) {}

  async exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ argv: [...argv], options });
    return this.responder(argv);
  }

  async exists(): Promise<boolean> {
    throw new Error('not used');
  }
  async mkdirp(): Promise<void> {
    throw new Error('not used');
  }
  async removeDir(): Promise<void> {
    throw new Error('not used');
  }
  async writeFileIfChanged(): Promise<boolean> {
    throw new Error('not used');
  }
  async reachability(): Promise<'ok'> {
    return 'ok';
  }
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

function lastRemoteCommand(runner: FakeRunner): string {
  const call = runner.calls[runner.calls.length - 1]!;
  return call.argv[call.argv.length - 1]!;
}

describe('buildControlPath', () => {
  it('stays well under the 104-byte sockaddr_un limit', () => {
    // Arrange
    const host = 'main.Web5-Yonatan.yonatanbal.coder';

    // Act
    const path = buildControlPath(host, 501);

    // Assert
    expect(path.length).toBeLessThan(104);
    expect(path.startsWith('/tmp/')).toBe(true);
  });

  it('is stable for a host and distinct between hosts', () => {
    expect(buildControlPath('a.host', 501)).toBe(buildControlPath('a.host', 501));
    expect(buildControlPath('a.host', 501)).not.toBe(buildControlPath('b.host', 501));
  });
});

describe('SshTransport.exec', () => {
  it('passes the multiplexing socket and BatchMode on every call', async () => {
    // Arrange
    const runner = new FakeRunner(() => ok());
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act
    await transport.exec(['tmux', '-V']);

    // Assert
    const argv = runner.calls[0]!.argv.join(' ');
    expect(argv).toContain('ControlPath=');
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('ControlMaster=auto');
  });

  it('shell-quotes arguments so spaces and quotes survive the remote shell', async () => {
    // Arrange
    const runner = new FakeRunner(() => ok());
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act
    await transport.exec(['echo', "it's here", 'two words']);

    // Assert
    expect(lastRemoteCommand(runner)).toBe(`echo 'it'\\''s here' 'two words'`);
  });

  it('prefixes cwd and env onto the remote command', async () => {
    // Arrange
    const runner = new FakeRunner(() => ok());
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act
    await transport.exec(['git', 'status'], { cwd: '/tmp/my dir', env: { A_KEY: 'a value' } });

    // Assert
    const command = lastRemoteCommand(runner);
    expect(command).toBe(`cd '/tmp/my dir' && A_KEY='a value' git status`);
  });

  it('ignores stderr content, because the Coder banner prints there', async () => {
    // Arrange
    const runner = new FakeRunner(() => ({
      stdout: 'real output',
      stderr: 'Running workspace agent startup scripts...',
      exitCode: 0,
    }));
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act
    const result = await transport.exec(['echo', 'hi']);

    // Assert
    expect(result.stdout).toBe('real output');
  });

  it('reports an ssh 255 exit as unreachable, not as a command failure', async () => {
    // Arrange
    const runner = new FakeRunner(() => {
      throw new ExecError('ssh failed', SSH_TRANSPORT_EXIT_CODE, '', 'no route to host');
    });
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act + Assert
    await expect(transport.exec(['true'])).rejects.toBeInstanceOf(TransportUnreachableError);
  });

  it('reports a timeout as unreachable rather than a command failure', async () => {
    // Arrange
    const runner = new FakeRunner(() => {
      throw new ExecError('timed out', 1, '', '', true);
    });
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act + Assert
    await expect(transport.exec(['true'])).rejects.toBeInstanceOf(TransportUnreachableError);
  });

  it('propagates a genuine non-zero exit as ExecError', async () => {
    // Arrange
    const runner = new FakeRunner(() => {
      throw new ExecError('exit 2', 2, '', 'fatal: not a git repository');
    });
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act + Assert
    await expect(transport.exec(['git', 'status'])).rejects.toBeInstanceOf(ExecError);
  });
});

describe('SshTransport.exists', () => {
  it('returns false only for a clean non-zero exit', async () => {
    // Arrange
    const runner = new FakeRunner(() => {
      throw new ExecError('exit 1', 1, '', '');
    });
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act + Assert
    expect(await transport.exists('/nope')).toBe(false);
  });

  it('throws rather than reporting "missing" when the host is unreachable', async () => {
    // Arrange — an unreachable host must never look like an empty filesystem,
    // or worktree setup would try to recreate live remote state.
    const runner = new FakeRunner(() => {
      throw new ExecError('ssh failed', SSH_TRANSPORT_EXIT_CODE, '', 'connection refused');
    });
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act + Assert
    await expect(transport.exists('/home/coder/project')).rejects.toBeInstanceOf(
      TransportUnreachableError
    );
  });
});

describe('SshTransport.writeFileIfChanged', () => {
  it('skips the write when remote content already matches', async () => {
    // Arrange
    const content = 'already there\n';
    const runner = new FakeRunner((argv) => {
      const command = argv[argv.length - 1] ?? '';
      return command.startsWith('cat ') ? ok(content) : ok();
    });
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act
    const written = await transport.writeFileIfChanged('/remote/file', content);

    // Assert
    expect(written).toBe(false);
    expect(runner.calls.some((c) => c.argv.join(' ').includes('base64 -d'))).toBe(false);
  });

  it('base64-encodes the payload so arbitrary content survives the shell', async () => {
    // Arrange
    const runner = new FakeRunner((argv) => {
      const command = argv[argv.length - 1] ?? '';
      if (command.startsWith('cat ')) {
        throw new ExecError('missing', 1, '', '');
      }
      return ok();
    });
    const transport = new SshTransport({ host: 'example.host', runner });
    const content = "#!/bin/bash\necho 'quoted' && $VAR\n";

    // Act
    const written = await transport.writeFileIfChanged('/remote/script.sh', content, 0o755);

    // Assert
    expect(written).toBe(true);
    const writeCall = runner.calls.find((c) => c.argv.join(' ').includes('base64 -d'));
    expect(writeCall).toBeDefined();
    expect(writeCall!.argv.join(' ')).toContain(Buffer.from(content, 'utf8').toString('base64'));
    expect(runner.calls.some((c) => c.argv.join(' ').includes('chmod'))).toBe(true);
  });
});

describe('SshTransport.reachability', () => {
  it('caches a successful probe instead of re-probing on every call', async () => {
    // Arrange
    let now = 1_000;
    const runner = new FakeRunner(() => ok());
    const transport = new SshTransport({ host: 'example.host', runner, now: () => now });

    // Act
    await transport.reachability();
    await transport.reachability();

    // Assert
    expect(runner.calls.length).toBe(1);
  });

  it('re-probes once the cache window has passed', async () => {
    // Arrange
    let now = 1_000;
    const runner = new FakeRunner(() => ok());
    const transport = new SshTransport({ host: 'example.host', runner, now: () => now });

    // Act
    await transport.reachability();
    now += 60_000;
    await transport.reachability();

    // Assert
    expect(runner.calls.length).toBe(2);
  });

  it('reports unreachable when the probe fails', async () => {
    // Arrange
    const runner = new FakeRunner(() => {
      throw new ExecError('ssh failed', SSH_TRANSPORT_EXIT_CODE, '', '');
    });
    const transport = new SshTransport({ host: 'example.host', runner });

    // Act + Assert
    expect(await transport.reachability()).toBe('unreachable');
  });
});
