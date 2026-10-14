// ============================================================
// AgentBoard CLI — the web board (`ui: "web"`)
// ============================================================
//
// The browser shows the board; the tmux layout session shows only the
// selected card's session. This file opens the browser and builds that layout:
// one window, marked with `@agentboard_web_layout`, whose first pane is a
// placeholder until the first card is clicked. The daemon does the pane moves
// from then on (`focusTask`, src/daemon/web-layout.ts).

import { spawn, spawnSync } from 'child_process';
import type { AppConfig } from '../types/index.js';
import { WEB_LAYOUT_WINDOW_OPTION } from '../daemon/web-layout.js';
import { loadOrCreateWebToken, webBoardUrl } from '../daemon/web-token.js';

export function webBoardUrlWithToken(config: AppConfig, stateDir: string): string {
  return webBoardUrl(config.web.port, loadOrCreateWebToken(stateDir));
}

export function openInBrowser(url: string): boolean {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command the placeholder pane runs: this same CLI, `web --home`. */
function placeholderCommand(): string {
  const argv = [process.execPath, ...process.execArgv, process.argv[1] ?? '', 'web', '--home'];
  return argv.map(shellQuote).join(' ');
}

function tmux(args: string[]): ReturnType<typeof spawnSync> {
  const result = spawnSync('tmux', args, { stdio: 'pipe', encoding: 'utf8' });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error('tmux not found. Install tmux to use the web board layout.');
  }
  return result;
}

function isWebLayoutSession(sessionName: string): boolean {
  const result = tmux(['list-windows', '-t', sessionName, '-F', `#{${WEB_LAYOUT_WINDOW_OPTION}}`]);
  return result.status === 0 && String(result.stdout).split('\n').some((line) => line.trim() === '1');
}

/**
 * Creates the web layout session if needed, then attaches to it (or switches
 * to it when already inside tmux). Refuses to replace a TUI layout session of
 * the same name: killing it would kill the card session showing in it.
 */
export function launchWebLayout(config: AppConfig): void {
  const sessionName = config.tmux.layoutSessionName;
  const exists = tmux(['has-session', '-t', sessionName]).status === 0;

  if (exists && !isWebLayoutSession(sessionName)) {
    throw new Error(
      `tmux session "${sessionName}" is running the TUI board. Quit it first (q), ` +
        `or run \`tmux kill-session -t ${sessionName}\`.`,
    );
  }

  if (!exists) {
    const created = tmux(['new-session', '-d', '-s', sessionName, placeholderCommand()]);
    if (created.status !== 0) {
      throw new Error(`Failed to create tmux session "${sessionName}": ${String(created.stderr).trim()}`);
    }
    tmux(['set-option', '-w', '-t', `${sessionName}:`, WEB_LAYOUT_WINDOW_OPTION, '1']);
  }

  const insideTmux = Boolean(process.env['TMUX']);
  const result = spawnSync('tmux', insideTmux ? ['switch-client', '-t', sessionName] : ['attach-session', '-t', sessionName], {
    stdio: 'inherit',
  });
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

/** What the placeholder pane shows until a card is clicked. Never returns. */
export async function runWebHome(url: string): Promise<never> {
  const lines = [
    '',
    '  AgentBoard — web board',
    '',
    `  Board: ${url}`,
    '',
    '  Click a card in the browser to show its session here.',
    '  Run `agentboard web` to open the board again.',
    '',
  ];
  process.stdout.write(lines.join('\n'));
  return new Promise<never>(() => {
    setInterval(() => undefined, 1 << 30);
  });
}
