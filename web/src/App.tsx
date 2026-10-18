import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from './api';
import {
  buildCardTree,
  CARD_STATE_LABEL,
  cardState,
  countFamily,
  findPRRelease,
  prBranches,
  prStage,
  PR_STAGE_LABEL,
  relativeTime,
  type BoardFilter,
  type BoardSnapshot,
  type CardNode,
  type CardState,
  type DoctorCheck,
  type FleetSessionStatus,
  type PRReleaseStatus,
  type TaskBranchRecord,
  type TaskRecord,
} from './model';
import { useBoard } from './useBoard';
import { Conversation, MarkdownText } from './Conversation';
import { ConfirmDialog, HelpDialog, NewCardDialog, TeleportDialog, TextDialog, type NewCardInput } from './Dialogs';
import { commandForKey, navigate, primaryPR, visibleCards, type Command } from './keys';

type FocusStatus = { taskId: string; kind: 'pending' | 'ok' | 'error'; message: string };

type Dialog =
  | { kind: 'new' }
  | { kind: 'rename'; task: TaskRecord }
  | { kind: 'delete'; task: TaskRecord }
  | { kind: 'restart'; task: TaskRecord }
  | { kind: 'teleport'; task: TaskRecord; checks: DoctorCheck[] | null; checkError: string | null }
  | { kind: 'help' };

type Toast = { kind: 'ok' | 'error'; text: string };

const LAYOUT_NOT_RUNNING = /web terminal layout is not running/i;

/** A field that takes typed text. A focused checkbox or button must not swallow the board's keys. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((el as HTMLInputElement).type);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked; the setting just won't stick.
  }
}

export function App() {
  const { board, fleet, releases, connection, signedIn, error } = useBoard();
  const [filter, setFilter] = useState<BoardFilter>(() =>
    readStored('agentboard.filter', { query: '', repoId: '', showShipped: false }),
  );
  const [selectedId, setSelectedId] = useState<string | null>(() => readStored('agentboard.selected', null));
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(readStored<string[]>('agentboard.collapsed', [])),
  );
  const [focus, setFocus] = useState<FocusStatus | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [detailOpen, setDetailOpen] = useState<boolean>(() => readStored('agentboard.detailOpen', true));
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => writeStored('agentboard.filter', { ...filter, query: '' }), [filter]);
  useEffect(() => writeStored('agentboard.selected', selectedId), [selectedId]);
  useEffect(() => writeStored('agentboard.collapsed', [...collapsed]), [collapsed]);
  useEffect(() => writeStored('agentboard.detailOpen', detailOpen), [detailOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.kind === 'error' ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Keep the keyboard selection on screen.
  useEffect(() => {
    if (selectedId) document.getElementById(`card-${selectedId}`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const tree = useMemo(
    () => (board ? buildCardTree(board, fleet, releases, filter) : []),
    [board, fleet, releases, filter],
  );
  const hiddenShipped = useMemo(() => {
    if (!board || filter.showShipped) return 0;
    const all = buildCardTree(board, fleet, releases, { ...filter, showShipped: true });
    return all.reduce((sum, node) => sum + countFamily(node), 0) - tree.reduce((sum, node) => sum + countFamily(node), 0);
  }, [board, fleet, releases, filter, tree]);

  const selected = board?.tasks.find((task) => task.id === selectedId) ?? null;

  const visible = useMemo(() => visibleCards(tree, collapsed), [tree, collapsed]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const showInTerminal = useCallback(async (task: TaskRecord) => {
    setFocus({ taskId: task.id, kind: 'pending', message: 'Opening session…' });
    try {
      await rpc('focusTask', { taskId: task.id });
      setFocus({ taskId: task.id, kind: 'ok', message: 'Showing in terminal' });
    } catch (err) {
      setFocus({ taskId: task.id, kind: 'error', message: errorText(err) });
    }
  }, []);

  const closeDialog = useCallback(() => {
    setDialog(null);
    setDialogBusy(false);
    setDialogError(null);
  }, []);

  /** Opens the teleport confirm and loads its preflight checks into it. */
  const openTeleport = useCallback((task: TaskRecord) => {
    if (task.kind === 'general') {
      setToast({ kind: 'error', text: 'General tasks have no repo to teleport' });
      return;
    }
    const direction = task.location === 'remote' ? 'remote-to-local' : 'local-to-remote';
    setDialog({ kind: 'teleport', task, checks: null, checkError: null });
    const settle = (checks: DoctorCheck[] | null, checkError: string | null) =>
      setDialog((current) =>
        current?.kind === 'teleport' && current.task.id === task.id ? { ...current, checks, checkError } : current,
      );
    rpc<DoctorCheck[]>('teleportTaskPreflight', { taskId: task.id, direction }).then(
      (checks) => settle(checks, null),
      (err) => settle(null, errorText(err)),
    );
  }, []);

  // A teleport has landed once the board says the card moved, whatever became
  // of the request that started it (a slow or dropped response, or a teleport
  // run from the TUI while this dialog sat open): close the now-stale dialog.
  useEffect(() => {
    if (dialog?.kind !== 'teleport') return;
    const live = board?.tasks.find((task) => task.id === dialog.task.id);
    if (!live || live.location === dialog.task.location) return;
    closeDialog();
    setToast({ kind: 'ok', text: live.location === 'remote' ? 'Teleported to remote' : 'Teleported to local' });
  }, [board, dialog, closeDialog]);

  /** Runs a dialog's action: the dialog stays open, showing the error, if it fails. */
  const runDialog = useCallback(
    async (action: () => Promise<string | void>) => {
      setDialogBusy(true);
      setDialogError(null);
      try {
        const message = await action();
        closeDialog();
        if (message) setToast({ kind: 'ok', text: message });
      } catch (err) {
        setDialogBusy(false);
        setDialogError(errorText(err));
      }
    },
    [closeDialog],
  );

  /** Runs an action with no dialog, reporting the outcome as a toast. */
  const runQuick = useCallback(async (pending: string, action: () => Promise<string>) => {
    setToast({ kind: 'ok', text: pending });
    try {
      setToast({ kind: 'ok', text: await action() });
    } catch (err) {
      setToast({ kind: 'error', text: errorText(err) });
    }
  }, []);

  const createCard = useCallback(
    (input: NewCardInput) =>
      runDialog(async () => {
        const repo = board?.repos.find((r) => r.id === input.repoId);
        const created = await rpc<TaskRecord>('createTask', {
          title: input.title,
          kind: repo ? 'repo' : 'general',
          repoId: repo?.id,
          pillarId: repo?.defaultPillarId,
          parentTaskId: input.parentTaskId,
          description: input.description || undefined,
          initialPrompt: input.description || undefined,
        });
        setSelectedId(created.id);
        if (input.parentTaskId) {
          setCollapsed((previous) => {
            const next = new Set(previous);
            next.delete(input.parentTaskId as string);
            return next;
          });
        }
        if (!input.start) return `Created “${created.title}”`;
        try {
          await rpc('focusTask', { taskId: created.id });
          setFocus({ taskId: created.id, kind: 'ok', message: 'Showing in terminal' });
        } catch (err) {
          // No layout to show it in: start it anyway, the user asked for that.
          if (!LAYOUT_NOT_RUNNING.test(errorText(err))) throw err;
          await rpc('openSession', { taskId: created.id, slot: 'primary' });
        }
        return `Created and started “${created.title}”`;
      }),
    [board, runDialog],
  );

  const runCommand = useCallback(
    (command: Command) => {
      const task = selected;
      if (typeof command === 'object') {
        const repo = board?.repos[command.repoIndex];
        if (repo) setFilter((f) => ({ ...f, repoId: f.repoId === repo.id ? '' : repo.id }));
        return;
      }
      switch (command) {
        case 'up':
        case 'down':
        case 'collapse':
        case 'expand': {
          const move = navigate(visible, selectedId, command, collapsed);
          if (move.toggle) toggleCollapsed(move.toggle);
          if (move.select) setSelectedId(move.select);
          return;
        }
        case 'search':
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case 'clear':
          if (filter.query) setFilter((f) => ({ ...f, query: '' }));
          return;
        case 'help':
          setDialog({ kind: 'help' });
          return;
        case 'new':
          setDialog({ kind: 'new' });
          return;
        case 'toggle-detail':
          setDetailOpen((open) => !open);
          return;
        case 'repo-prev':
        case 'repo-next': {
          const ids = ['', ...(board?.repos.map((r) => r.id) ?? [])];
          const step = command === 'repo-next' ? 1 : -1;
          setFilter((f) => ({ ...f, repoId: ids[(ids.indexOf(f.repoId) + step + ids.length) % ids.length] ?? '' }));
          return;
        }
        case 'sync':
          void runQuick('Syncing with GitHub…', async () => {
            await rpc('triggerSync');
            return 'Sync done';
          });
          return;
        case 'needs-you': {
          if (!board) return;
          const all = visibleCards(buildCardTree(board, fleet, releases, { ...filter, showShipped: true }), new Set());
          const target = all.find((card) => card.node.state === 'needs-you');
          if (!target) {
            setToast({ kind: 'ok', text: 'No card needs you right now' });
            return;
          }
          // Unfold its ancestors so the selection is on screen.
          setCollapsed((previous) => {
            const next = new Set(previous);
            for (let t = board.tasks.find((x) => x.id === target.node.task.id); t?.parentTaskId; ) {
              next.delete(t.parentTaskId);
              t = board.tasks.find((x) => x.id === t?.parentTaskId);
            }
            return next;
          });
          setSelectedId(target.node.task.id);
          return;
        }
      }

      if (!task) {
        setToast({ kind: 'error', text: 'Select a card first' });
        return;
      }
      switch (command) {
        case 'show':
          void showInTerminal(task);
          return;
        case 'rename':
          setDialog({ kind: 'rename', task });
          return;
        case 'delete':
          setDialog({ kind: 'delete', task });
          return;
        case 'restart':
          setDialog({ kind: 'restart', task });
          return;
        case 'teleport':
          openTeleport(task);
          return;
        case 'open-checks': {
          const url = primaryPR(task)?.prUrl;
          if (!url) {
            setToast({ kind: 'error', text: 'This card has no pull request yet' });
            return;
          }
          window.open(`${url}/checks`, '_blank', 'noopener');
          return;
        }
      }
    },
    [board, collapsed, filter, fleet, openTeleport, releases, runQuick, selected, selectedId, showInTerminal, toggleCollapsed, visible],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog) return; // the dialog has the keyboard
      if (isTyping(event.target)) {
        if (event.key === 'Escape' && event.target === searchRef.current) {
          setFilter((f) => ({ ...f, query: '' }));
          searchRef.current?.blur();
        } else if (event.key === 'Enter' && event.target === searchRef.current) {
          // Like the TUI: Enter in the search jumps to the first match.
          searchRef.current?.blur();
          const first = visible[0];
          if (first) setSelectedId(first.node.task.id);
        }
        return;
      }
      const command = commandForKey(event);
      if (!command) return;
      event.preventDefault();
      runCommand(command);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, runCommand, visible]);

  const selectCard = useCallback(
    (task: TaskRecord) => {
      setSelectedId(task.id);
      void showInTerminal(task);
    },
    [showInTerminal],
  );


  if (!signedIn) {
    return (
      <div className="empty-screen">
        <h1>Sign in to the board</h1>
        <p>
          This page needs the sign-in link from the CLI. Run <code>agentboard web</code> in a terminal; it opens
          the board signed in.
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          AgentBoard
          <span className={`conn conn-${connection}`} title={`Daemon: ${connection}`}>
            {connection === 'live' ? 'live' : connection === 'connecting' ? 'connecting…' : 'offline'}
          </span>
        </div>
        <div className="filters">
          <input
            ref={searchRef}
            id="search"
            type="search"
            placeholder="Search cards, branches, #PR   ( / )"
            value={filter.query}
            onChange={(event) => setFilter({ ...filter, query: event.target.value })}
          />
          <select
            id="repo-filter"
            value={filter.repoId}
            onChange={(event) => setFilter({ ...filter, repoId: event.target.value })}
          >
            <option value="">All repos</option>
            {board?.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.label}
              </option>
            ))}
          </select>
          <label className="toggle">
            <input
              id="show-shipped"
              type="checkbox"
              checked={filter.showShipped}
              onChange={(event) => setFilter({ ...filter, showShipped: event.target.checked })}
            />
            Show shipped{hiddenShipped > 0 ? ` (${hiddenShipped})` : ''}
          </label>
          <button className="primary" onClick={() => setDialog({ kind: 'new' })} title="New card (n)">
            + New card
          </button>
          <button className="icon-button" onClick={() => setDialog({ kind: 'help' })} title="Keyboard shortcuts (?)">
            ?
          </button>
        </div>
      </header>

      {error && <div className="banner">{error}</div>}

      <div className={detailOpen ? 'layout' : 'layout no-detail'}>
        <main className="tree" aria-label="Cards">
          {!board && <p className="muted pad">Loading board…</p>}
          {board && tree.length === 0 && (
            <p className="muted pad">
              {filter.query || filter.repoId ? 'No cards match these filters.' : 'No active cards.'}
            </p>
          )}
          <ul className="tree-list" role="tree">
            {tree.map((node) => (
              <CardBranch
                key={node.task.id}
                node={node}
                depth={0}
                board={board as BoardSnapshot}
                releases={releases}
                selectedId={selectedId}
                collapsed={collapsed}
                focus={focus}
                onSelect={selectCard}
                onToggle={toggleCollapsed}
                onTeleport={openTeleport}
              />
            ))}
          </ul>
        </main>

        {detailOpen && (
          <aside className="detail" aria-label="Card details">
            {selected && board ? (
              <CardDetail
                task={selected}
                board={board}
                fleet={fleet}
                releases={releases.get(selected.id)}
                focus={focus?.taskId === selected.id ? focus : null}
                onSelect={(task) => setSelectedId(task.id)}
                onCommand={runCommand}
              />
            ) : (
              <div className="detail-empty">
                <p>Select a card to see its pull requests and conversation.</p>
                <p className="muted">
                  Clicking a card also shows its Claude session in the terminal. Arrows move, Enter shows, ? lists
                  every key.
                </p>
              </div>
            )}
          </aside>
        )}
      </div>

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      {board && dialog?.kind === 'new' && (
        <NewCardDialog
          board={board}
          defaultRepoId={filter.repoId || selected?.repoId}
          selected={selected}
          busy={dialogBusy}
          error={dialogError}
          onSubmit={(input) => void createCard(input)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'rename' && (
        <TextDialog
          title="Rename card"
          label="Title"
          initial={dialog.task.title}
          submitLabel="Rename"
          busy={dialogBusy}
          error={dialogError}
          onSubmit={(title) =>
            void runDialog(async () => {
              await rpc('renameTask', { id: dialog.task.id, title });
            })
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete card"
          danger
          confirmLabel="Delete"
          body={
            <>
              <p>
                Delete <strong>{dialog.task.title}</strong>? Its sessions are stopped and its worktrees removed.
              </p>
              <p className="muted small">
                Uncommitted work is committed first and kept under <code>refs/agentboard/archive/{dialog.task.id}</code>.
                {board && board.tasks.some((t) => t.parentTaskId === dialog.task.id) && ' Its subtasks stay on the board.'}
              </p>
            </>
          }
          busy={dialogBusy}
          error={dialogError}
          onConfirm={() => {
            // Closed at once: archiving and removing a big worktree can take a
            // while, and a dialog that sits on "Working…" reads as a hang.
            const task = dialog.task;
            const index = visible.findIndex((card) => card.node.task.id === task.id);
            const next = visible[index + 1] ?? visible[index - 1];
            setSelectedId(next && next.node.task.id !== task.id ? next.node.task.id : null);
            closeDialog();
            void runQuick(`Deleting “${task.title}”…`, async () => {
              const outcome = await rpc<{ archivedShas: string[]; archiveRef: string }>('deleteTask', { id: task.id });
              return outcome.archivedShas.length > 0
                ? `Deleted “${task.title}”. Uncommitted work saved at ${outcome.archiveRef}`
                : `Deleted “${task.title}”`;
            });
          }}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'restart' && (
        <ConfirmDialog
          title="Restart session"
          confirmLabel="Restart"
          body={
            <p>
              Kill the session pane of <strong>{dialog.task.title}</strong> and start it again? The branch, worktree
              and conversation are kept.
            </p>
          }
          busy={dialogBusy}
          error={dialogError}
          onConfirm={() =>
            void runDialog(async () => {
              const task = dialog.task;
              await rpc('recreateSession', { taskId: task.id, slot: 'primary' });
              void showInTerminal(task);
              return 'Session restarted';
            })
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'teleport' && (
        <TeleportDialog
          task={dialog.task}
          checks={dialog.checks}
          checkError={dialog.checkError}
          busy={dialogBusy}
          error={dialogError}
          onConfirm={() =>
            void runDialog(async () => {
              const task = dialog.task;
              const toRemote = task.location !== 'remote';
              await rpc('teleportTask', { taskId: task.id, direction: toRemote ? 'local-to-remote' : 'remote-to-local' });
              // The pane the terminal showed died with the old session: show the new one if it was on screen.
              if (focus?.taskId === task.id) void showInTerminal(task);
              return toRemote ? 'Teleported to remote' : 'Teleported to local';
            })
          }
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'help' && <HelpDialog onClose={closeDialog} />}
    </div>
  );
}

// ---------------------------------------------------------------- tree

interface CardBranchProps {
  node: CardNode;
  depth: number;
  board: BoardSnapshot;
  releases: ReadonlyMap<string, PRReleaseStatus[]>;
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  focus: FocusStatus | null;
  onSelect: (task: TaskRecord) => void;
  onToggle: (id: string) => void;
  onTeleport: (task: TaskRecord) => void;
}

function CardBranch(props: CardBranchProps) {
  const { node, depth, board, releases, selectedId, collapsed, focus, onSelect, onToggle, onTeleport } = props;
  const { task } = node;
  const isCollapsed = collapsed.has(task.id);
  const hasChildren = node.children.length > 0;
  const repo = board.repos.find((r) => r.id === task.repoId);
  const prs = prBranches(task);
  const taskReleases = releases.get(task.id);
  const pending = focus?.taskId === task.id && focus.kind === 'pending';

  return (
    <li id={`card-${task.id}`} role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined} aria-selected={selectedId === task.id}>
      <div
        className={[
          'card',
          `state-${node.state}`,
          selectedId === task.id ? 'selected' : '',
          task.isOrchestrator ? 'orchestrator' : '',
          task.location === 'remote' ? 'remote' : '',
          node.shipped ? 'shipped' : '',
          depth === 0 ? 'root' : 'child',
        ].join(' ')}
      >
        {hasChildren ? (
          <button
            className="twisty"
            aria-label={isCollapsed ? 'Expand subtasks' : 'Collapse subtasks'}
            onClick={() => onToggle(task.id)}
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="twisty-spacer" />
        )}
        <button className="card-main" onClick={() => onSelect(task)}>
          <span className="card-line1">
            <StateChip state={node.state} />
            <span className="card-title">{task.title}</span>
            {task.location === 'remote' && <RemoteTag />}
            {task.isOrchestrator && <span className="tag">orchestrator</span>}
            {task.childPrAlertTaskId && <span className="tag tag-alert">subtask PR</span>}
            {pending && <span className="spinner" aria-label="Opening session" />}
          </span>
          <span className="card-line2">
            <span className="muted">{repo?.label ?? 'general'}</span>
            {task.branchName && <span className="mono muted">{task.branchName}</span>}
            {prs.map((branch) => (
              <PRChip key={branch.id} branch={branch} release={findPRRelease(branch, taskReleases)} />
            ))}
            {hasChildren && (
              <span className="muted">
                {countFamily(node) - 1} subtask{countFamily(node) - 1 === 1 ? '' : 's'}
              </span>
            )}
            <span className="muted push">{relativeTime(task.updatedAt)}</span>
          </span>
        </button>
        {task.kind !== 'general' && (
          <button
            className="card-teleport"
            onClick={() => onTeleport(task)}
            title={task.location === 'remote' ? 'Teleport to local (T)' : 'Teleport to remote (T)'}
            aria-label={task.location === 'remote' ? 'Teleport to local' : 'Teleport to remote'}
          >
            ⇄
          </button>
        )}
      </div>
      {hasChildren && !isCollapsed && (
        <ul className="tree-list nested" role="group">
          {node.children.map((child) => (
            <CardBranch {...props} key={child.task.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function RemoteTag() {
  return (
    <span className="tag tag-remote" title="Runs on the remote host">
      ☁ remote
    </span>
  );
}

function StateChip({ state }: { state: CardState }) {
  return <span className={`chip chip-state chip-${state}`}>{CARD_STATE_LABEL[state]}</span>;
}

function PRChip({ branch, release }: { branch: TaskBranchRecord; release?: PRReleaseStatus }) {
  const stage = prStage(branch, release);
  return (
    <span className={`chip chip-pr pr-${stage}`} title={`${branch.branchName} · ${PR_STAGE_LABEL[stage]}`}>
      #{branch.prNumber} {PR_STAGE_LABEL[stage]}
      {(stage === 'open' || stage === 'draft') && <CIGlyph branch={branch} />}
    </span>
  );
}

function CIGlyph({ branch }: { branch: TaskBranchRecord }) {
  if (branch.ciState === 'passed') return <span className="ci ci-passed" aria-label="CI passed"> ✓</span>;
  if (branch.ciState === 'failed') return <span className="ci ci-failed" aria-label="CI failed"> ✗</span>;
  if (branch.ciState === 'pending') return <span className="ci ci-pending" aria-label="CI running"> ●</span>;
  return null;
}

// ---------------------------------------------------------------- detail

interface CardDetailProps {
  task: TaskRecord;
  board: BoardSnapshot;
  fleet: FleetSessionStatus[];
  releases?: PRReleaseStatus[];
  focus: FocusStatus | null;
  onSelect: (task: TaskRecord) => void;
  onCommand: (command: Command) => void;
}

function CardDetail({ task, board, fleet, releases, focus, onSelect, onCommand }: CardDetailProps) {
  const state = cardState(task, fleet);
  const repo = board.repos.find((r) => r.id === task.repoId);
  const parent = task.parentTaskId ? board.tasks.find((t) => t.id === task.parentTaskId) : undefined;
  const children = board.tasks.filter((t) => t.parentTaskId === task.id);
  const sessions = fleet.filter((row) => row.taskId === task.id);
  const labels = task.labels
    .map((id) => board.labels.find((label) => label.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  const branches = [...task.branches].sort((a, b) => a.sortKey - b.sortKey);

  return (
    <article className="detail-body">
      {parent && (
        <button className="crumb" onClick={() => onSelect(parent)}>
          ↳ {parent.title}
        </button>
      )}
      <h1 className="detail-title">{task.title}</h1>
      <div className="detail-chips">
        <StateChip state={state} />
        {task.location === 'remote' && <RemoteTag />}
        {task.isOrchestrator && <span className="tag">orchestrator</span>}
        {labels.map((label) => (
          <span key={label} className="tag">
            {label}
          </span>
        ))}
      </div>

      {focus && (
        <div className="actions">
          <span className={`focus-msg focus-${focus.kind}`}>{focus.message}</span>
        </div>
      )}
      <div className="toolbar">
        <ToolButton label="Rename" shortcut="r" onClick={() => onCommand('rename')} />
        <ToolButton label="Restart" shortcut="R" onClick={() => onCommand('restart')} />
        <ToolButton
          label={task.location === 'remote' ? 'Teleport to local' : 'Teleport to remote'}
          shortcut="T"
          onClick={() => onCommand('teleport')}
          disabled={task.kind === 'general'}
        />
        <ToolButton label="Delete" shortcut="d" onClick={() => onCommand('delete')} danger />
      </div>

      <Conversation taskId={task.id} />

      <dl className="meta">
        <dt>Repo</dt>
        <dd>{repo?.label ?? 'General task'}</dd>
        {task.branchName && (
          <>
            <dt>Branch</dt>
            <dd className="mono">{task.branchName}</dd>
          </>
        )}
        {task.sessionName && (
          <>
            <dt>Session</dt>
            <dd className="mono">{task.sessionName}</dd>
          </>
        )}
        <dt>Runs on</dt>
        <dd>{task.location === 'remote' ? 'Remote host' : 'This machine'}</dd>
        <dt>Agent</dt>
        <dd>
          {task.agentCli}
          {sessions.length > 0 &&
            ` · ${sessions.length} live session${sessions.length > 1 ? 's' : ''} (${sessions
              .map((row) => row.slot)
              .join(', ')})`}
        </dd>
        <dt>Created</dt>
        <dd>{new Date(task.createdAt).toLocaleString()}</dd>
        <dt>Updated</dt>
        <dd>{relativeTime(task.updatedAt)}</dd>
      </dl>

      <section>
        <h2>Pull requests</h2>
        {branches.length === 0 ? (
          <p className="muted">No branches yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="prs">
              <thead>
                <tr>
                  <th>PR</th>
                  <th>Stage</th>
                  <th>CI</th>
                  <th>Review</th>
                  <th>Release</th>
                </tr>
              </thead>
              <tbody>
                {branches.map((branch) => (
                  <PRRow key={branch.id} branch={branch} board={board} release={findPRRelease(branch, releases)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {children.length > 0 && (
        <section>
          <h2>Subtasks</h2>
          <ul className="subtasks">
            {children.map((child) => (
              <li key={child.id}>
                <button className="link" onClick={() => onSelect(child)}>
                  <StateChip state={cardState(child, fleet)} /> {child.title}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.description && (
        <section>
          <h2>Description</h2>
          <MarkdownText className="description term" text={task.description} />
        </section>
      )}
    </article>
  );
}

function ToolButton(props: { label: string; shortcut: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      className={props.danger ? 'tool danger' : 'tool'}
      onClick={props.onClick}
      disabled={props.disabled}
      title={`${props.label} (${props.shortcut})`}
    >
      {props.label} <kbd>{props.shortcut}</kbd>
    </button>
  );
}

function PRRow({ branch, board, release }: { branch: TaskBranchRecord; board: BoardSnapshot; release?: PRReleaseStatus }) {
  const stage = prStage(branch, release);
  const repo = board.repos.find((r) => r.id === branch.repoId);
  return (
    <tr>
      <td>
        {branch.prNumber && branch.prUrl ? (
          <a href={branch.prUrl} target="_blank" rel="noreferrer">
            #{branch.prNumber}
          </a>
        ) : (
          <span className="muted">—</span>
        )}
        <div className="muted small mono">
          {repo?.label ? `${repo.label} · ` : ''}
          {branch.branchName}
        </div>
        {branch.githubSyncError && <div className="error small">{branch.githubSyncError}</div>}
      </td>
      <td>
        <span className={`chip chip-pr pr-${stage}`}>{PR_STAGE_LABEL[stage]}</span>
      </td>
      <td>
        <CICell branch={branch} />
      </td>
      <td>
        <ReviewCell branch={branch} />
      </td>
      <td>
        <ReleaseCell release={release} merged={branch.prState === 'merged'} />
      </td>
    </tr>
  );
}

function CICell({ branch }: { branch: TaskBranchRecord }) {
  if (branch.prState === 'none' || branch.ciState === 'none') return <span className="muted">—</span>;
  const counts =
    branch.ciRequiredTotal > 0 ? ` ${branch.ciRequiredPassed}/${branch.ciRequiredTotal}` : '';
  if (branch.ciState === 'passed') return <span className="ci-passed">✓ Passed{counts}</span>;
  if (branch.ciState === 'pending') return <span className="ci-pending">● Running{counts}</span>;
  return (
    <span className="ci-failed" title={branch.ciSummary}>
      ✗ {branch.failingCheckName ?? 'Failed'}
      {counts}
    </span>
  );
}

function ReviewCell({ branch }: { branch: TaskBranchRecord }) {
  const label =
    branch.reviewState === 'approved'
      ? 'Approved'
      : branch.reviewState === 'changes_requested'
        ? 'Changes requested'
        : branch.reviewState === 'commented'
          ? 'Commented'
          : '—';
  return (
    <span className={`review-${branch.reviewState}`}>
      {label}
      {branch.unresolvedThreadCount > 0 && (
        <span className="muted small">
          {' '}
          · {branch.unresolvedThreadCount} open thread{branch.unresolvedThreadCount > 1 ? 's' : ''}
        </span>
      )}
    </span>
  );
}

function ReleaseCell({ release, merged }: { release?: PRReleaseStatus; merged: boolean }) {
  if (!merged) return <span className="muted">—</span>;
  if (!release) return <span className="muted">Not checked yet</span>;
  if (release.stage === 'no-artifact') return <span className="muted">Nothing to deploy</span>;
  if (release.stage === 'unknown') return <span className="muted">Unknown{release.reason ? ` (${release.reason})` : ''}</span>;
  const gating = release.artifacts.filter((artifact) => artifact.gates);
  return (
    <ul className="artifacts">
      {(gating.length > 0 ? gating : release.artifacts).map((artifact) => (
        <li key={artifact.artifactName} title={artifact.artifactName}>
          <span className="mono">{artifact.shortName}</span>{' '}
          <span className="muted small">
            {artifact.stage}
            {artifact.containingRcVersion ? ` · RC ${artifact.containingRcVersion}` : ''}
            {artifact.gaVersion ? ` · GA ${artifact.gaVersion}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
