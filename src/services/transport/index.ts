import { LocalTransport } from './local.js';
import { SshTransport } from './ssh.js';
import { SocketForward } from './socket-forward.js';
import type { ExecTransport } from './types.js';

export { LocalTransport } from './local.js';
export { SshTransport, buildControlPath } from './ssh.js';
export { SocketForward, type SocketForwardStatus } from './socket-forward.js';
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
  private forwardSource: { localSocket: string; log?: (message: string) => void } | null = null;
  private forward: SocketForward | null = null;

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

  /**
   * Let remote sessions reach the daemon: from now on {@link getSocketForward}
   * hands out a forward of `localSocket` (the daemon's remote-RPC socket) to the
   * remote host. Only the daemon calls this; without it there is no forward.
   */
  enableSocketForward(localSocket: string, log?: (message: string) => void): void {
    this.forwardSource = { localSocket, log };
  }

  /**
   * The forward of the daemon's socket to the remote host, or null when none
   * was enabled. Tied to the current remote transport: a reset stops it, and
   * the next call builds a fresh one over the fresh transport.
   */
  getSocketForward(): SocketForward | null {
    if (!this.forwardSource || !this.remoteConfig) {
      return null;
    }
    if (!this.forward) {
      const transport = this.getRemote();
      this.forward = new SocketForward({
        host: transport.host,
        localSocket: this.forwardSource.localSocket,
        remoteExec: (argv) => transport.exec(argv),
        log: this.forwardSource.log,
      });
    }
    return this.forward;
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
    this.forward?.stop();
    this.forward = null;
    const remote = this.remote;
    if (!remote) {
      return;
    }
    this.remote = null;
    await remote.disconnect();
  }

  /**
   * Stop the forward without touching the ControlMaster. Daemon shutdown uses
   * this, not {@link shutdown}: the master is shared with every remote card's
   * attach loop (remote-attach.sh), and `ssh -O exit` would cut them all.
   * The forward's ssh is a child of the daemon, and a child outlives its
   * parent unless something kills it.
   */
  stopSocketForward(): void {
    this.forward?.stop();
  }

  async shutdown(): Promise<void> {
    this.forward?.stop();
    if (this.remote) {
      await this.remote.disconnect();
    }
  }
}
