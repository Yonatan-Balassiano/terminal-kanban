import type { RemoteWorkspaceStatus } from '../../types/index.js';

/**
 * Something that can report on, and power up, the machine remote tasks run on.
 *
 * SSH tells AgentBoard whether a host answers; it cannot tell a workspace that
 * is switched off from a VPN that is down, and it cannot switch one back on.
 * A provider supplies exactly that missing half, and nothing else — session and
 * worktree handling stay on the transport.
 */
export interface RemoteHostProvider {
  /** Human-readable name of the target, for status messages. */
  readonly label: string;

  /** Current power state. Never throws; an unanswerable probe is 'unknown'. */
  status(): Promise<RemoteWorkspaceStatus>;

  /** Request a start. Returns once the build is dispatched, not once it finishes. */
  start(): Promise<void>;

  /** Poll until the host reports running. Resolves false on failure or timeout. */
  waitUntilRunning(): Promise<boolean>;
}
