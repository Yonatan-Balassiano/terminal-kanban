import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SHORTCUTS } from './keys';
import type { BoardSnapshot, TaskRecord } from './model';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export interface NewCardInput {
  title: string;
  repoId?: string;
  description: string;
  parentTaskId?: string;
  start: boolean;
}

export function NewCardDialog(props: {
  board: BoardSnapshot;
  defaultRepoId?: string;
  selected: TaskRecord | null;
  busy: boolean;
  error: string | null;
  onSubmit: (input: NewCardInput) => void;
  onClose: () => void;
}) {
  const { board, selected, busy, error, onSubmit, onClose } = props;
  const [title, setTitle] = useState('');
  const [repoId, setRepoId] = useState(props.defaultRepoId ?? board.repos[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const [asSubtask, setAsSubtask] = useState(false);
  const [start, setStart] = useState(true);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);

  const submit = () => {
    if (!title.trim() || busy) return;
    onSubmit({
      title: title.trim(),
      repoId: repoId || undefined,
      description: description.trim(),
      parentTaskId: asSubtask && selected ? selected.id : undefined,
      start,
    });
  };

  return (
    <Modal title="New card" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <label>
          Title
          <input ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} required />
        </label>
        <label>
          Repo
          <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
            {board.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.label}
              </option>
            ))}
            <option value="">No repo (general task)</option>
          </select>
        </label>
        <label>
          Brief for the agent
          <textarea
            rows={7}
            value={description}
            placeholder="What to do, why, where to look. This becomes the agent's first prompt."
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {selected && (
          <label className="check">
            <input type="checkbox" checked={asSubtask} onChange={(event) => setAsSubtask(event.target.checked)} />
            Subtask of “{selected.title}”
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={start} onChange={(event) => setStart(event.target.checked)} />
          Start the agent now
        </label>
        {error && <p className="error small">{error}</p>}
        <div className="form-actions">
          <span className="muted small">⌘ Enter to create</span>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!title.trim() || busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function TextDialog(props: {
  title: string;
  label: string;
  initial?: string;
  multiline?: boolean;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(props.initial ?? '');
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const submit = () => {
    if (value.trim() && !props.busy) props.onSubmit(value.trim());
  };
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <label>
          {props.label}
          {props.multiline ? (
            <textarea ref={ref} rows={6} value={value} onChange={(event) => setValue(event.target.value)} />
          ) : (
            <input ref={ref} value={value} onChange={(event) => setValue(event.target.value)} />
          )}
        </label>
        {props.error && <p className="error small">{props.error}</p>}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!value.trim() || props.busy}>
            {props.busy ? 'Working…' : props.submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog(props: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div className="form">
        <div>{props.body}</div>
        {props.error && <p className="error small">{props.error}</p>}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button
            ref={ref}
            type="button"
            className={props.danger ? 'primary danger' : 'primary'}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? 'Working…' : props.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="help">
        {SHORTCUTS.map((group) => (
          <section key={group.section}>
            <h3>{group.section}</h3>
            <dl>
              {group.items.map((item) => (
                <div key={item.keys} className="help-row">
                  <dt>
                    {item.keys.split('  ').map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{item.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
