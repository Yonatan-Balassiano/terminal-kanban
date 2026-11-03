import { useEffect, useState } from 'react';
import { rpc } from './api';
import { relativeTime, type TaskRecord } from './model';
import type { GetTaskArtifactsResult } from '../../src/types/index.js';

/** Artifacts change only when an agent publishes one, so this is slower than the conversation's poll. */
const POLL_MS = 30_000;

/**
 * The claude.ai Artifacts this card's sessions published, and those of every
 * subtask under it, read from their transcripts. Refreshed while the card is
 * selected and the page is visible.
 */
export function Artifacts({
  task,
  tasks,
  onSelect,
}: {
  task: TaskRecord;
  tasks: readonly TaskRecord[];
  onSelect: (task: TaskRecord) => void;
}) {
  const [data, setData] = useState<GetTaskArtifactsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taskId = task.id;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    setData(null);
    setError(null);
    const load = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const result = await rpc<GetTaskArtifactsResult>('getTaskArtifacts', { taskId, includeSubtasks: true });
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [taskId]);

  // Nothing to say about a card that never published anything: keep the pane short.
  if (!error && (!data || (data.artifacts.length === 0 && data.remoteTaskIds.length === 0))) {
    return null;
  }

  const titleOf = (id: string) => tasks.find((t) => t.id === id);
  return (
    <section>
      <h2>
        Artifacts
        {data && data.artifacts.length > 0 && <span className="h2-note">{data.artifacts.length}</span>}
      </h2>
      {error && <p className="error small">{error}</p>}
      {data && data.artifacts.length > 0 && (
        <ul className="artifact-list">
          {data.artifacts.map((artifact) => {
            const source = artifact.taskId !== taskId ? titleOf(artifact.taskId) : undefined;
            return (
              <li key={artifact.url}>
                <a href={artifact.url} target="_blank" rel="noreferrer" title={artifact.url}>
                  {artifact.title ?? artifact.url}
                </a>
                <span className="muted small">
                  {artifact.versions > 1 ? ` · v${artifact.versions}` : ''}
                  {artifact.lastPublishedAt ? ` · ${relativeTime(artifact.lastPublishedAt)}` : ''}
                </span>
                {source && (
                  <button className="link small artifact-source" onClick={() => onSelect(source)}>
                    ↳ {source.title}
                  </button>
                )}
                {artifact.description && <div className="muted small">{artifact.description}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {data && data.remoteTaskIds.length > 0 && (
        <p className="muted small">
          {data.remoteTaskIds.length === 1 && data.remoteTaskIds[0] === taskId
            ? 'This card runs on a remote host; artifacts it published there are not listed.'
            : `${data.remoteTaskIds.length} card${data.remoteTaskIds.length > 1 ? 's run' : ' runs'} on a remote host; artifacts published there are not listed.`}
        </p>
      )}
    </section>
  );
}
