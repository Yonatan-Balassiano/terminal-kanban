import { execSync } from 'child_process';
import { existsSync, accessSync, constants } from 'fs';
import { dirname } from 'path';
import { createRequire } from 'module';
import type { Db } from '../db/index.js';
import type { DoctorCheck, DoctorResult, RemoteConfig } from '../types/index.js';
import { createRemoteProvider } from './remote/index.js';
import { SshTransport } from './transport/index.js';

const require = createRequire(import.meta.url);

export class DoctorService {
  constructor(
    private db: Db,
    private socketPath: string,
    private remote?: RemoteConfig
  ) {}

  async run(): Promise<DoctorResult> {
    const checks = await Promise.all([
      this.checkNodeVersion(),
      this.checkGit(),
      this.checkTmux(),
      this.checkNodePty(),
      this.checkGh(),
      this.checkGhAuth(),
      this.checkDelta(),
      this.checkDb(),
      this.checkSocket(),
      this.checkRepos(),
      this.checkRemote(),
    ]);

    // checkRepos returns an array of checks; flatten
    return checks.flat();
  }

  /**
   * Remote-host checks, skipped entirely when no remote is configured.
   *
   * The tool versions are read in one SSH round trip rather than four, since
   * each one costs a network hop.
   */
  private async checkRemote(): Promise<DoctorCheck[]> {
    const remote = this.remote;
    if (!remote) {
      return [];
    }

    const transport = new SshTransport({
      host: remote.sshHost,
      connectTimeoutMs: remote.connectTimeoutMs,
      commandTimeoutMs: remote.commandTimeoutMs,
    });

    // Asked first, because "the workspace is switched off" and "your VPN is
    // down" both look like an unreachable host over SSH, and only one of them
    // is fixed by starting the workspace.
    const workspaceChecks = await this.checkRemoteWorkspace(remote);

    const startedAt = Date.now();
    if ((await transport.reachability()) !== 'ok') {
      return [
        ...workspaceChecks,
        {
          name: 'remote:ssh',
          status: 'fail',
          message: `Cannot reach remote host ${remote.sshHost}`,
          remediation: `Check your VPN, then verify: ssh ${remote.sshHost} true`,
        },
      ];
    }

    const checks: DoctorCheck[] = [
      ...workspaceChecks,
      {
        name: 'remote:ssh',
        status: 'pass',
        message: `Connected to ${remote.sshHost} (${Date.now() - startedAt}ms)`,
      },
    ];

    checks.push(await this.checkRemoteTools(transport));
    checks.push(await this.checkRemoteDaemonSocket(transport));
    checks.push(...(await this.checkRemoteRepos(transport)));
    return checks;
  }

  /**
   * Power state of the remote host, when something can report on it.
   *
   * Empty when no provider is configured — there is then nothing to say beyond
   * what the SSH probe already reports.
   */
  private async checkRemoteWorkspace(remote: RemoteConfig): Promise<DoctorCheck[]> {
    const provider = createRemoteProvider(remote);
    if (!provider) {
      return [];
    }

    const status = await provider.status();
    const name = 'remote:workspace';

    switch (status) {
      case 'running':
        return [{ name, status: 'pass', message: `${provider.label} is running` }];
      case 'starting':
        return [{ name, status: 'warn', message: `${provider.label} is still starting` }];
      case 'stopped':
        return [
          {
            name,
            status: 'fail',
            message: `${provider.label} is stopped`,
            remediation: `Reconnect a remote card to start it, or run: coder start ${provider.label}`,
          },
        ];
      case 'failed':
        return [
          {
            name,
            status: 'fail',
            message: `${provider.label} is in a failed state`,
            remediation: `Inspect the last build in Coder, then: coder start ${provider.label}`,
          },
        ];
      default:
        return [
          {
            name,
            status: 'warn',
            message: `Could not read the state of ${provider.label}`,
            remediation: 'Verify the `coder` CLI is installed and logged in: coder list',
          },
        ];
    }
  }

  private async checkRemoteTools(transport: SshTransport): Promise<DoctorCheck> {
    const required = ['tmux', 'git', 'claude'];
    try {
      const { stdout } = await transport.exec([
        'sh',
        '-c',
        required.map((tool) => `command -v ${tool} >/dev/null 2>&1 && echo ${tool}`).join('; '),
      ]);
      const found = new Set(stdout.split('\n').map((line) => line.trim()));
      const missing = required.filter((tool) => !found.has(tool));

      if (missing.length > 0) {
        return {
          name: 'remote:tools',
          status: 'fail',
          message: `Missing on the remote host: ${missing.join(', ')}`,
          remediation: `Install them on ${transport.host}, or they will not be on the session PATH`,
        };
      }
      return { name: 'remote:tools', status: 'pass', message: `Found: ${required.join(', ')}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { name: 'remote:tools', status: 'fail', message: `Tool probe failed: ${message}` };
    }
  }

  /**
   * Whether a remote card's agentboard CLI can reach this daemon: the mirrored
   * CLI pings it through the forwarded socket, so a pass means the whole path
   * works, not just that an ssh process is running. The forward is only up
   * while a remote card has a session, so its absence alone is a warning.
   */
  private async checkRemoteDaemonSocket(transport: SshTransport): Promise<DoctorCheck> {
    const name = 'remote:daemon-socket';
    const probe = [
      'cli="$HOME/.agentboard/bin/agentboard"',
      'sock="$HOME/.agentboard/run/daemon.sock"',
      'command -v python3 >/dev/null 2>&1 || { echo no-python; exit 0; }',
      '[ -x "$cli" ] || { echo no-cli; exit 0; }',
      '[ -S "$sock" ] || { echo no-socket; exit 0; }',
      '"$cli" ping 2>&1 || true',
    ].join('; ');
    let stdout: string;
    try {
      ({ stdout } = await transport.exec(['sh', '-c', probe]));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, status: 'fail', message: `Probe failed: ${message}` };
    }
    const answer = stdout.trim().split('\n').pop() ?? '';

    switch (answer) {
      case 'no-python':
        return {
          name,
          status: 'fail',
          message: 'python3 is not on the remote host, so remote cards cannot run agentboard',
          remediation: `Install python3 on ${transport.host}`,
        };
      case 'no-cli':
        return {
          name,
          status: 'warn',
          message: 'The agentboard CLI has not been mirrored to the remote host yet',
          remediation: 'It is set up when the next remote card opens (needs a daemon with this version)',
        };
      case 'no-socket':
        return {
          name,
          status: 'warn',
          message: 'The daemon socket is not forwarded (normal while no remote card is open)',
          remediation:
            'Open or reconnect a remote card; the daemon log shows the forward as [remote-cli] lines',
        };
      default: {
        const pid = /^ok pid=(\d+)/.exec(answer)?.[1];
        if (pid) {
          return {
            name,
            status: 'pass',
            message: `Remote cards reach the daemon (pid ${pid}) over the forwarded socket`,
          };
        }
        return {
          name,
          status: 'fail',
          message: `The forwarded socket is there but does not answer: ${answer || 'no output'}`,
          remediation: 'Reconnect a remote card to rebuild the forward, or restart the daemon',
        };
      }
    }
  }

  private async checkRemoteRepos(transport: SshTransport): Promise<DoctorCheck[]> {
    let repos: Array<Record<string, unknown>>;
    try {
      repos = this.db
        .prepare<[], Record<string, unknown>>(
          'SELECT label, remote_path FROM repos WHERE remote_path IS NOT NULL',
        )
        .all();
    } catch {
      return [];
    }

    if (repos.length === 0) {
      return [
        {
          name: 'remote:repos',
          status: 'warn',
          message: 'No repo has a remote path configured',
          remediation: 'Set "remotePath" on a repo to create remote tasks for it',
        },
      ];
    }

    return Promise.all(
      repos.map(async (repo): Promise<DoctorCheck> => {
        const label = repo['label'] as string;
        const remotePath = repo['remote_path'] as string;
        const name = `remote:repos:${label}`;
        try {
          if (!(await transport.exists(`${remotePath}/.git`))) {
            return {
              name,
              status: 'warn',
              message: `Not a git repo on the remote host: ${remotePath}`,
              remediation: `Clone it there, or clear "remotePath" for ${label}`,
            };
          }
          return { name, status: 'pass', message: `${remotePath} OK` };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { name, status: 'fail', message: `Could not check ${remotePath}: ${message}` };
        }
      }),
    );
  }

  // --------------- Individual checks -----------------------

  private checkNodeVersion(): DoctorCheck {
    const version = process.version; // e.g. "v20.11.0"
    const major = parseInt(version.slice(1).split('.')[0], 10);
    if (major >= 24) {
      return { name: 'node-version', status: 'pass', message: version };
    }
    return {
      name: 'node-version',
      status: 'fail',
      message: `Node ${version} is too old`,
      remediation: 'Upgrade to Node.js v24',
    };
  }

  private checkGit(): DoctorCheck {
    try {
      const out = execSync('git --version', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return { name: 'git', status: 'pass', message: out };
    } catch {
      return { name: 'git', status: 'fail', message: 'git not found' };
    }
  }

  private checkTmux(): DoctorCheck {
    try {
      const out = execSync('tmux -V', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return { name: 'tmux', status: 'pass', message: out };
    } catch {
      return {
        name: 'tmux',
        status: 'fail',
        message: 'tmux not found',
        remediation:
          'Install tmux (macOS: brew install tmux) or set sessionBackend to "pty" in AgentBoard config',
      };
    }
  }

  private checkNodePty(): DoctorCheck {
    try {
      require('node-pty');
      return { name: 'node-pty', status: 'pass', message: 'node-pty available' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: 'node-pty',
        status: 'fail',
        message: `node-pty not available: ${message}`,
        remediation:
          'Reinstall dependencies (npm install) or use a supported Node/OS combo for native addons',
      };
    }
  }

  private checkGh(): DoctorCheck {
    try {
      const out = execSync('gh --version', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return { name: 'gh', status: 'pass', message: out.split('\n')[0] };
    } catch {
      return {
        name: 'gh',
        status: 'fail',
        message: 'GitHub CLI (gh) not found',
        remediation: 'Install GitHub CLI: brew install gh',
      };
    }
  }

  private checkGhAuth(): DoctorCheck {
    try {
      execSync('gh auth status', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { name: 'gh-auth', status: 'pass', message: 'Authenticated with GitHub' };
    } catch {
      return {
        name: 'gh-auth',
        status: 'warn',
        message: 'Not authenticated with GitHub',
        remediation: 'Run: gh auth login',
      };
    }
  }

  private checkDelta(): DoctorCheck {
    try {
      const out = execSync('delta --version', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return { name: 'delta', status: 'pass', message: out };
    } catch {
      return {
        name: 'delta',
        status: 'warn',
        message: 'delta not found (optional — used for diff highlighting)',
        remediation: 'Install delta: brew install git-delta',
      };
    }
  }

  private checkDb(): DoctorCheck {
    try {
      const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
      // Try to open the same DB by probing the database
      this.db.prepare('SELECT 1').get();
      // If we need to verify the file path, use pragma
      const result = this.db.prepare<[], { database_list: string }>('PRAGMA database_list').all();
      const dbFile =
        ((result[0] as unknown as Record<string, unknown>)?.['file'] as string) ?? 'in-memory';
      void BetterSqlite3; // referenced to satisfy no-unused-vars
      return { name: 'db', status: 'pass', message: `Database OK: ${dbFile}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { name: 'db', status: 'fail', message: `Database error: ${msg}` };
    }
  }

  private checkSocket(): DoctorCheck {
    const dir = dirname(this.socketPath);
    try {
      accessSync(dir, constants.W_OK);
      return { name: 'socket', status: 'pass', message: `Socket directory writable: ${dir}` };
    } catch {
      return {
        name: 'socket',
        status: 'fail',
        message: `Socket directory not writable: ${dir}`,
        remediation: `Ensure ${dir} exists and is writable`,
      };
    }
  }

  private checkRepos(): DoctorCheck[] {
    let repos: Array<Record<string, unknown>>;
    try {
      repos = this.db
        .prepare<[], Record<string, unknown>>('SELECT id, label, path FROM repos')
        .all();
    } catch {
      return [
        {
          name: 'repos',
          status: 'fail',
          message: 'Could not query repos from database',
        },
      ];
    }

    if (repos.length === 0) {
      return [{ name: 'repos', status: 'pass', message: 'No repos registered' }];
    }

    return repos.map((repo): DoctorCheck => {
      const label = repo['label'] as string;
      const path = repo['path'] as string;
      const checkName = `repos:${label}`;

      if (!existsSync(path)) {
        return {
          name: checkName,
          status: 'warn',
          message: `Repo path missing: ${path}`,
          remediation: `Re-add the repository or update its path`,
        };
      }

      if (!existsSync(`${path}/.git`)) {
        return {
          name: checkName,
          status: 'warn',
          message: `Path exists but is not a git repo: ${path}`,
          remediation: `Verify that ${path} is still a git repository`,
        };
      }

      return { name: checkName, status: 'pass', message: `${label}: ${path}` };
    });
  }
}
