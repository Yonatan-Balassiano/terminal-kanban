// Talks to the daemon's web transport: POST /api/rpc and SSE on /api/events.

export class NotSignedInError extends Error {}

export async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  if (res.status === 401) {
    throw new NotSignedInError('Not signed in');
  }
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) {
    throw new Error(body.error.message);
  }
  return body.result as T;
}

export type ConnectionState = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to daemon pushes. EventSource reconnects by itself after a
 * daemon restart; `onState` reports it so the UI can say so.
 */
export function subscribe(
  onEvent: (type: string, payload: unknown) => void,
  onState: (state: ConnectionState) => void,
): () => void {
  const source = new EventSource('/api/events');
  onState('connecting');
  source.onopen = () => onState('live');
  source.onerror = () => onState(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
  for (const type of ['board_patch', 'sync_status']) {
    source.addEventListener(type, (event) => {
      try {
        onEvent(type, JSON.parse((event as MessageEvent<string>).data));
      } catch {
        // Ignore a malformed push; the next one replaces it.
      }
    });
  }
  return () => source.close();
}
