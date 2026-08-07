import { LocalTransport } from './local.js';
import { SshTransport } from './ssh.js';
import type { ExecTransport } from './types.js';

export { LocalTransport } from './local.js';
export { SshTransport, buildControlPath } from './ssh.js';
export * from './types.js';

export interface RemoteHostConfig {
  sshHost: string;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/**
 * Owns the process-wide transports.
 *
 * The local transport is always available; the remote one is created lazily on
 * first use so that a board with no remote tasks never opens an SSH connection.
 */
export class TransportRegistry {
  private readonly local = new LocalTransport();
  private readonly remoteConfig: RemoteHostConfig | undefined;
  private remote: SshTransport | null = null;

  constructor(remoteConfig?: RemoteHostConfig) {
    this.remoteConfig = remoteConfig;
  }

  /** Whether a remote host is configured at all. */
  get hasRemote(): boolean {
    return this.remoteConfig !== undefined;
  }

  get remoteHost(): string | undefined {
    return this.remoteConfig?.sshHost;
  }

  getLocal(): ExecTransport {
    return this.local;
  }

  /** Throws when a remote task exists but no remote host is configured. */
  getRemote(): SshTransport {
    if (!this.remoteConfig) {
      throw new Error(
        'No remote host configured. Set "remote": { "sshHost": "..." } in your AgentBoard config.'
      );
    }
    if (!this.remote) {
      this.remote = new SshTransport({
        host: this.remoteConfig.sshHost,
        connectTimeoutMs: this.remoteConfig.connectTimeoutMs,
        commandTimeoutMs: this.remoteConfig.commandTimeoutMs,
      });
    }
    return this.remote;
  }

  /** Resolve the transport a task should run on. */
  forLocation(location: 'local' | 'remote'): ExecTransport {
    return location === 'remote' ? this.getRemote() : this.local;
  }

  /**
   * Drop the remote transport so the next `getRemote()` builds a fresh one.
   *
   * After the host reboots, the ControlMaster socket still exists but its
   * connection is dead, and the transport's unreachable-cache would keep
   * answering "unreachable" for another 10s. Both are per-instance state, so
   * closing the master and discarding the instance is the only way to make a
   * reconnect see the host that is actually there now.
   */
  async resetRemote(): Promise<void> {
    const remote = this.remote;
    if (!remote) {
      return;
    }
    this.remote = null;
    await remote.disconnect();
  }

  async shutdown(): Promise<void> {
    if (this.remote) {
      await this.remote.disconnect();
    }
  }
}
