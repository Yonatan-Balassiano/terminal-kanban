import { useCallback, useEffect, useRef, useState } from 'react';
import { NotSignedInError, rpc, subscribe, type ConnectionState } from './api';
import { prBranches, type BoardSnapshot, type FleetSessionStatus, type PRReleaseStatus } from './model';

const FLEET_POLL_MS = 4_000;
/** Release status is served from the daemon's cache, so this only bounds staleness. */
const RELEASE_REFRESH_MS = 60_000;

export interface BoardData {
  board: BoardSnapshot | null;
  fleet: FleetSessionStatus[];
  releases: ReadonlyMap<string, PRReleaseStatus[]>;
  connection: ConnectionState;
  signedIn: boolean;
  error: string | null;
}

export function useBoard(): BoardData {
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [fleet, setFleet] = useState<FleetSessionStatus[]>([]);
  const [releases, setReleases] = useState<ReadonlyMap<string, PRReleaseStatus[]>>(new Map());
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [signedIn, setSignedIn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const releaseFetchedAt = useRef(new Map<string, number>());

  const handleError = useCallback((err: unknown) => {
    if (err instanceof NotSignedInError) {
      setSignedIn(false);
      return;
    }
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const fleetInFlight = useRef(false);

  // One request at a time, and none while the tab is hidden: a fleet pass can
  // take seconds, and the browser allows only six connections to the daemon,
  // shared by every open tab. Polls stacked behind a slow one used to take all
  // of them, leaving the conversation and every action stuck behind the queue.
  const loadFleet = useCallback(async () => {
    if (fleetInFlight.current || document.hidden) {
      return;
    }
    fleetInFlight.current = true;
    try {
      const result = await rpc<{ sessions: FleetSessionStatus[] }>('getFleetStatus');
      setFleet(result.sessions);
    } catch (err) {
      handleError(err);
    } finally {
      fleetInFlight.current = false;
    }
  }, [handleError]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await rpc<BoardSnapshot>('getBoard');
        if (!cancelled) {
          setBoard(snapshot);
          setError(null);
        }
      } catch (err) {
        handleError(err);
      }
    })();
    void loadFleet();

    const unsubscribe = subscribe(
      (type, payload) => {
        if (type === 'board_patch' && payload && typeof payload === 'object') {
          setBoard(payload as BoardSnapshot);
          setError(null);
          void loadFleet();
        }
      },
      setConnection,
    );
    const timer = window.setInterval(() => void loadFleet(), FLEET_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void loadFleet();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [handleError, loadFleet]);

  // Per-PR release stage, only for cards that have something merged.
  useEffect(() => {
    if (!board) {
      return;
    }
    const now = Date.now();
    const due = board.tasks.filter((task) => {
      if (!prBranches(task).some((branch) => branch.prState === 'merged')) {
        return false;
      }
      const fetched = releaseFetchedAt.current.get(task.id) ?? 0;
      return now - fetched > RELEASE_REFRESH_MS;
    });
    if (due.length === 0) {
      return;
    }
    for (const task of due) {
      releaseFetchedAt.current.set(task.id, now);
    }
    void Promise.all(
      due.map(async (task) => {
        try {
          const result = await rpc<{ statuses: PRReleaseStatus[] }>('getReleaseStatus', { taskId: task.id });
          return [task.id, result.statuses] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      setReleases((previous) => {
        const next = new Map(previous);
        for (const entry of entries) {
          if (entry) {
            next.set(entry[0], entry[1]);
          }
        }
        return next;
      });
    });
  }, [board]);

  return { board, fleet, releases, connection, signedIn, error };
}
