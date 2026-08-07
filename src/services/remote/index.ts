import type { RemoteConfig } from '../../types/index.js';
import { LocalTransport, type ExecTransport } from '../transport/index.js';
import { CoderProvider } from './coder.js';
import type { RemoteHostProvider } from './types.js';

export { CoderProvider, normalizeWorkspaceName } from './coder.js';
export type { RemoteHostProvider } from './types.js';

/**
 * Build the provider for the configured remote host, or null when none is set.
 *
 * Null is the normal case: a board with no remote host, or one whose host is
 * always on. Reconnect still works without a provider — it just cannot power
 * anything up.
 */
export function createRemoteProvider(
  remote: RemoteConfig | undefined,
  transport: ExecTransport = new LocalTransport()
): RemoteHostProvider | null {
  if (!remote?.provider || !remote.workspace) {
    return null;
  }

  switch (remote.provider) {
    case 'coder':
      return new CoderProvider({
        transport,
        workspace: remote.workspace,
        coderBin: remote.coderBin,
        startTimeoutMs: remote.startTimeoutMs,
      });
    default:
      return null;
  }
}
