// ============================================================
// AgentBoard — tmux layout for the web board
// ============================================================
//
// With `ui: "web"` the board lives in the browser, so the tmux layout window
// holds nothing but the selected card's session. Selecting a card in the
// browser has to put that card's pane into the window — the job the Go TUI's
// `attachTaskSessionInTmux` (internal/tui/tmux_layout.go) does for its own
// window, minus the board pane. The pane bookkeeping (the
// `@agentboard_backend_session_id` tag, the holding session, the layout lock)
// is shared with the Go side on purpose, so a pane parked by one is found by
// the other.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Window option marking the one window the web layout owns. */
export const WEB_LAYOUT_WINDOW_OPTION = '@agentboard_web_layout';
/** Pane option marking the web layout's placeholder, the only untagged pane it may move. */
export const WEB_PLACEHOLDER_PANE_OPTION = '@agentboard_web_placeholder';
const BACKEND_SESSION_PANE_OPTION = '@agentboard_backend_session_id';
const HOLDING_SESSION_NAME = 'agentboard-task-panes';
const LAYOUT_LOCK_NAME = 'agentboard_attach_layout';

export interface TmuxRunner {
  run(args: string[]): Promise<string>;
}

export const execTmuxRunner: TmuxRunner = {
  async run(args) {
    const { stdout } = await execFileAsync('tmux', args, { encoding: 'utf8' });
    return stdout;
  },
};

interface PaneRecord {
  id: string;
  backendSessionId: string;
  placeholder: boolean;
}

const PANE_FORMAT = `#{pane_id}\t#{${BACKEND_SESSION_PANE_OPTION}}\t#{${WEB_PLACEHOLDER_PANE_OPTION}}`;

function parsePanes(output: string): PaneRecord[] {
  return output
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([id]) => (id ?? '').trim().length > 0)
    .map(([id, tag, placeholder]) => ({
      id: (id ?? '').trim(),
      backendSessionId: (tag ?? '').trim(),
      placeholder: (placeholder ?? '').trim() === '1',
    }));
}

/**
 * The web layout's window, found by its marker option rather than by index or
 * session: window indexes move as windows come and go, and run from inside
 * tmux the layout is whichever window `agentboard --ui web` was started in.
 */
export async function findWebLayoutWindow(runner: TmuxRunner): Promise<string | null> {
  let output: string;
  try {
    output = await runner.run(['list-windows', '-a', '-F', `#{window_id}\t#{${WEB_LAYOUT_WINDOW_OPTION}}`]);
  } catch {
    return null;
  }
  for (const line of output.split('\n')) {
    const [windowId, marker] = line.split('\t');
    if (windowId && marker?.trim() === '1') {
      return windowId.trim();
    }
  }
  return null;
}

async function findBackendPanes(runner: TmuxRunner, backendSessionId: string): Promise<string[]> {
  try {
    const tagged = parsePanes(
      await runner.run(['list-panes', '-a', '-F', PANE_FORMAT]),
    )
      .filter((pane) => pane.backendSessionId === backendSessionId)
      .map((pane) => pane.id);
    if (tagged.length > 0) {
      return tagged;
    }
  } catch {
    // Fall through to the session's own pane.
  }

  try {
    const paneId = (
      await runner.run(['display-message', '-p', '-t', backendSessionId, '#{pane_id}'])
    ).trim();
    return paneId ? [paneId] : [];
  } catch {
    return [];
  }
}

async function ensureHoldingSession(runner: TmuxRunner): Promise<void> {
  try {
    await runner.run(['has-session', '-t', `=${HOLDING_SESSION_NAME}`]);
    return;
  } catch {
    // Not there yet.
  }
  await runner.run([
    'new-session',
    '-d',
    '-s',
    HOLDING_SESSION_NAME,
    "sh -lc 'while :; do sleep 3600; done'",
  ]);
  await runner.run(['set-option', '-q', '-t', `=${HOLDING_SESSION_NAME}`, 'destroy-unattached', 'off']);
}

/**
 * Show `backendSessionId`'s pane(s) in the web layout window, parking whatever
 * was there in the holding session. Returns the pane now selected.
 *
 * The new panes are joined in before the old ones leave: a window with no
 * panes is destroyed, and with it the layout session the terminal is attached
 * to. The placeholder is parked along with the old card panes.
 */
export async function focusSessionInWebLayout(runner: TmuxRunner, backendSessionId: string): Promise<string> {
  const windowId = await findWebLayoutWindow(runner);
  if (!windowId) {
    throw new Error('The web layout is not running. Start it with `agentboard --ui web` in a terminal.');
  }

  await runner.run(['wait-for', '-L', LAYOUT_LOCK_NAME]);
  try {
    const visible = parsePanes(
      await runner.run(['list-panes', '-t', windowId, '-F', PANE_FORMAT]),
    );

    // Already showing, with nothing of another card's and no placeholder left: just focus it.
    const showing = visible.filter((pane) => pane.backendSessionId === backendSessionId);
    const stale = visible.filter(
      (pane) => pane.placeholder || (pane.backendSessionId && pane.backendSessionId !== backendSessionId),
    );
    const shown = showing[0];
    if (shown && stale.length === 0) {
      await runner.run(['select-window', '-t', windowId]);
      await runner.run(['select-pane', '-t', shown.id]);
      return shown.id;
    }

    const sources = (await findBackendPanes(runner, backendSessionId)).filter(
      (paneId) => !visible.some((pane) => pane.id === paneId),
    );
    if (sources.length === 0 && showing.length === 0) {
      throw new Error(`tmux pane for session ${backendSessionId} was not found`);
    }

    const anchor = visible[visible.length - 1]?.id ?? windowId;
    const joined: string[] = [];
    for (const source of sources) {
      // Tag before moving, so the pane stays findable once it has left the
      // session it was born in.
      await runner.run(['set-option', '-p', '-q', '-t', source, BACKEND_SESSION_PANE_OPTION, backendSessionId]);
      const target = joined[joined.length - 1] ?? anchor;
      await runner.run(['join-pane', joined.length === 0 ? '-h' : '-v', '-s', source, '-t', target]);
      joined.push(source);
    }

    const toPark: string[] = [];
    for (const pane of visible) {
      if (pane.backendSessionId === backendSessionId) {
        continue;
      }
      if (pane.backendSessionId || pane.placeholder) {
        // The placeholder is parked, not killed: run inside tmux it is the
        // user's own `agentboard --ui web` process, and it is what
        // `keepWebLayoutAlive` puts back when the card's pane goes away.
        toPark.push(pane.id);
      }
      // Any other pane is the user's own (a shell next to the layout): left alone.
    }
    if (toPark.length > 0) {
      await ensureHoldingSession(runner);
      for (const paneId of toPark) {
        await runner.run(['break-pane', '-d', '-s', paneId, '-t', `=${HOLDING_SESSION_NAME}:`]);
      }
    }

    const selected = (joined[0] ?? shown?.id) as string;
    // Bring the window forward, for a terminal looking at another window of its session.
    await runner.run(['select-window', '-t', windowId]);
    await runner.run(['select-pane', '-t', selected]);
    return selected;
  } finally {
    await runner.run(['wait-for', '-U', LAYOUT_LOCK_NAME]).catch(() => undefined);
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a new placeholder pane runs: this same CLI, `web --home`. Works
 * from the CLI and from the daemon, which run the same entry script.
 */
export function webPlaceholderCommand(): string {
  const argv = [process.execPath, ...process.execArgv, process.argv[1] ?? '', 'web', '--home'];
  return argv.map(shellQuote).join(' ');
}

/**
 * Called before `dyingPanes` are killed. If they are everything the web layout
 * window holds, the placeholder goes back in first — the parked one, or a new
 * one — because tmux destroys a window when its last pane dies, and with it
 * the terminal's view (and the whole session, if it was the only window).
 * Best-effort: a failure here must never stop the kill.
 */
export async function keepWebLayoutAlive(
  runner: TmuxRunner,
  dyingPanes: readonly string[],
  placeholderCommand: string = webPlaceholderCommand(),
): Promise<void> {
  if (dyingPanes.length === 0) {
    return;
  }
  const windowId = await findWebLayoutWindow(runner);
  if (!windowId) {
    return;
  }
  try {
    await runner.run(['wait-for', '-L', LAYOUT_LOCK_NAME]);
  } catch {
    return;
  }
  try {
    const visible = parsePanes(await runner.run(['list-panes', '-t', windowId, '-F', PANE_FORMAT]));
    const anchor = visible[0]?.id;
    if (!anchor || visible.some((pane) => !dyingPanes.includes(pane.id))) {
      return; // Something else stays, so the window does too.
    }
    const parked = parsePanes(await runner.run(['list-panes', '-a', '-F', PANE_FORMAT])).find(
      (pane) => pane.placeholder && !visible.some((shown) => shown.id === pane.id),
    );
    if (parked) {
      await runner.run(['join-pane', '-h', '-s', parked.id, '-t', anchor]);
      return;
    }
    const created = (
      await runner.run(['split-window', '-h', '-t', anchor, '-P', '-F', '#{pane_id}', placeholderCommand])
    ).trim();
    if (created) {
      await runner.run(['set-option', '-p', '-t', created, WEB_PLACEHOLDER_PANE_OPTION, '1']);
    }
  } catch {
    // Best-effort, see above.
  } finally {
    await runner.run(['wait-for', '-U', LAYOUT_LOCK_NAME]).catch(() => undefined);
  }
}

/** Reads a process's parent pid and executable path; injectable for tests. */
export type ProcessParentLookup = (pid: number) => Promise<{ ppid: number; command: string } | null>;

const execProcessParent: ProcessParentLookup = async (pid) => {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' });
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
    return match ? { ppid: Number(match[1]), command: match[2] as string } : null;
  } catch {
    return null;
  }
};

/**
 * The macOS app bundle of the terminal showing the web layout window: the tmux
 * client attached to the window's session is a descendant of the terminal
 * app's process (Ghostty → login → shell → tmux), so walk up from it to the
 * first executable inside a `.app` bundle.
 */
export async function findWebLayoutTerminalApp(
  runner: TmuxRunner,
  parentOf: ProcessParentLookup = execProcessParent,
): Promise<string | null> {
  const windowId = await findWebLayoutWindow(runner);
  if (!windowId) {
    return null;
  }
  let clientPids: number[];
  try {
    const sessionId = (await runner.run(['display-message', '-p', '-t', windowId, '#{session_id}'])).trim();
    clientPids = (await runner.run(['list-clients', '-t', sessionId, '-F', '#{client_pid}']))
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => pid > 1);
  } catch {
    return null;
  }
  for (const clientPid of clientPids) {
    let pid = clientPid;
    for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
      const proc = await parentOf(pid);
      if (!proc) break;
      const bundle = /^(.*?\.app)\/Contents\/MacOS\//.exec(proc.command);
      if (bundle) {
        return bundle[1] as string;
      }
      pid = proc.ppid;
    }
  }
  return null;
}

/**
 * Brings the terminal showing the web layout to the front, so a card clicked
 * in the browser is in front of the user without a trip to the dock.
 * macOS only, and best-effort: a terminal it cannot find is left where it is.
 */
export async function activateWebLayoutTerminal(runner: TmuxRunner): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }
  const app = await findWebLayoutTerminalApp(runner);
  if (app) {
    await execFileAsync('open', [app]).catch(() => undefined);
  }
}
