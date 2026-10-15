// The web board's sign-in token and URL, kept apart from web-server.ts so the
// CLI can build the URL without loading the daemon's dispatch.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Reads the token, creating it (mode 0600) the first time. */
export function loadOrCreateWebToken(stateDir: string): string {
  const file = path.join(stateDir, 'web-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // Not created yet.
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

export function webBoardUrl(port: number, token?: string): string {
  const base = `http://127.0.0.1:${port}/`;
  return token ? `${base}?t=${encodeURIComponent(token)}` : base;
}
