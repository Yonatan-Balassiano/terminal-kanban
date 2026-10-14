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
}

function parsePanes(output: string): PaneRecord[] {
  return output
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([id]) => (id ?? '').trim().length > 0)
    .map(([id, tag]) => ({ id: (id ?? '').trim(), backendSessionId: (tag ?? '').trim() }));
}

/**
 * The web layout's window, found by its marker option rather than by index:
 * window indexes move as windows come and go.
 */
export async function findWebLayoutWindow(
  runner: TmuxRunner,
  layoutSessionName: string,
): Promise<string | null> {
  let output: string;
  try {
    output = await runner.run([
      'list-windows',
      '-t',
      layoutSessionName,
      '-F',
      `#{window_id}\t#{${WEB_LAYOUT_WINDOW_OPTION}}`,
    ]);
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
      await runner.run(['list-panes', '-a', '-F', `#{pane_id}\t#{${BACKEND_SESSION_PANE_OPTION}}`]),
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
    await runner.run(['has-session', '-t', HOLDING_SESSION_NAME]);
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
  await runner.run(['set-option', '-q', '-t', HOLDING_SESSION_NAME, 'destroy-unattached', 'off']);
}

/**
 * Show `backendSessionId`'s pane(s) in the web layout window, parking whatever
 * was there in the holding session. Returns the pane now selected.
 *
 * The new panes are joined in before the old ones leave: a window with no
 * panes is destroyed, and with it the layout session the terminal is attached
 * to.
 */
export async function focusSessionInWebLayout(
  runner: TmuxRunner,
  layoutSessionName: string,
  backendSessionId: string,
): Promise<string> {
  const windowId = await findWebLayoutWindow(runner, layoutSessionName);
  if (!windowId) {
    throw new Error(
      `The web layout is not running. Start it with \`agentboard --ui web\` (tmux session "${layoutSessionName}").`,
    );
  }

  await runner.run(['wait-for', '-L', LAYOUT_LOCK_NAME]);
  try {
    const visible = parsePanes(
      await runner.run([
        'list-panes',
        '-t',
        windowId,
        '-F',
        `#{pane_id}\t#{${BACKEND_SESSION_PANE_OPTION}}`,
      ]),
    );

    const first = visible[0];
    if (first && visible.every((pane) => pane.backendSessionId === backendSessionId)) {
      await runner.run(['select-pane', '-t', first.id]);
      return first.id;
    }

    const sources = (await findBackendPanes(runner, backendSessionId)).filter(
      (paneId) => !visible.some((pane) => pane.id === paneId),
    );
    if (sources.length === 0) {
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
      if (pane.backendSessionId) {
        toPark.push(pane.id);
      } else {
        // The placeholder pane, or a stray shell: nothing to keep.
        await runner.run(['kill-pane', '-t', pane.id]);
      }
    }
    if (toPark.length > 0) {
      await ensureHoldingSession(runner);
      for (const paneId of toPark) {
        await runner.run(['break-pane', '-d', '-s', paneId, '-t', `${HOLDING_SESSION_NAME}:`]);
      }
    }

    const selected = joined[0] as string;
    await runner.run(['select-pane', '-t', selected]);
    return selected;
  } finally {
    await runner.run(['wait-for', '-U', LAYOUT_LOCK_NAME]).catch(() => undefined);
  }
}
