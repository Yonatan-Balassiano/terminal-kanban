import { execSync } from 'child_process';
import { existsSync, accessSync, constants } from 'fs';
import { dirname } from 'path';
import { createRequire } from 'module';
import type { Db } from '../db/index.js';
import type { DoctorCheck, DoctorResult } from '../types/index.js';

const require = createRequire(import.meta.url);

export class DoctorService {
  constructor(
    private db: Db,
    private socketPath: string,
  ) {}

  async run(): Promise<DoctorResult> {
    const checks = await Promise.all([
      this.checkNodeVersion(),
      this.checkGit(),
      this.checkTmux(),
      this.checkGh(),
      this.checkGhAuth(),
      this.checkDelta(),
      this.checkDb(),
      this.checkSocket(),
      this.checkRepos(),
    ]);

    // checkRepos returns an array of checks; flatten
    return checks.flat();
  }

  // --------------- Individual checks -----------------------

  private checkNodeVersion(): DoctorCheck {
    const version = process.version; // e.g. "v20.11.0"
    const major = parseInt(version.slice(1).split('.')[0], 10);
    if (major >= 24) {
      return { name: 'node-version', status: 'pass', message: version };
    }
    return {
      name: 'node-version',
      status: 'fail',
      message: `Node ${version} is too old`,
      remediation: 'Upgrade to Node.js v24',
    };
  }

  private checkGit(): DoctorCheck {
    try {
      const out = execSync('git --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return { name: 'git', status: 'pass', message: out };
    } catch {
      return { name: 'git', status: 'fail', message: 'git not found' };
    }
  }

  private checkTmux(): DoctorCheck {
    try {
      const out = execSync('tmux -V', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return { name: 'tmux', status: 'pass', message: out };
    } catch {
      return {
        name: 'tmux',
        status: 'fail',
        message: 'tmux not found',
        remediation: 'Install tmux: brew install tmux',
      };
    }
  }

  private checkGh(): DoctorCheck {
    try {
      const out = execSync('gh --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return { name: 'gh', status: 'pass', message: out.split('\n')[0] };
    } catch {
      return {
        name: 'gh',
        status: 'fail',
        message: 'GitHub CLI (gh) not found',
        remediation: 'Install GitHub CLI: brew install gh',
      };
    }
  }

  private checkGhAuth(): DoctorCheck {
    try {
      execSync('gh auth status', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return { name: 'gh-auth', status: 'pass', message: 'Authenticated with GitHub' };
    } catch {
      return {
        name: 'gh-auth',
        status: 'warn',
        message: 'Not authenticated with GitHub',
        remediation: 'Run: gh auth login',
      };
    }
  }

  private checkDelta(): DoctorCheck {
    try {
      const out = execSync('delta --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return { name: 'delta', status: 'pass', message: out };
    } catch {
      return {
        name: 'delta',
        status: 'warn',
        message: 'delta not found (optional — used for diff highlighting)',
        remediation: 'Install delta: brew install git-delta',
      };
    }
  }

  private checkDb(): DoctorCheck {
    try {
      const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
      // Try to open the same DB by probing the database
      this.db.prepare('SELECT 1').get();
      // If we need to verify the file path, use pragma
      const result = this.db.prepare<[], { database_list: string }>('PRAGMA database_list').all();
      const dbFile = (result[0] as unknown as Record<string, unknown>)?.['file'] as string ?? 'in-memory';
      void BetterSqlite3; // referenced to satisfy no-unused-vars
      return { name: 'db', status: 'pass', message: `Database OK: ${dbFile}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { name: 'db', status: 'fail', message: `Database error: ${msg}` };
    }
  }

  private checkSocket(): DoctorCheck {
    const dir = dirname(this.socketPath);
    try {
      accessSync(dir, constants.W_OK);
      return { name: 'socket', status: 'pass', message: `Socket directory writable: ${dir}` };
    } catch {
      return {
        name: 'socket',
        status: 'fail',
        message: `Socket directory not writable: ${dir}`,
        remediation: `Ensure ${dir} exists and is writable`,
      };
    }
  }

  private checkRepos(): DoctorCheck[] {
    let repos: Array<Record<string, unknown>>;
    try {
      repos = this.db
        .prepare<[], Record<string, unknown>>('SELECT id, label, path FROM repos')
        .all();
    } catch {
      return [
        {
          name: 'repos',
          status: 'fail',
          message: 'Could not query repos from database',
        },
      ];
    }

    if (repos.length === 0) {
      return [{ name: 'repos', status: 'pass', message: 'No repos registered' }];
    }

    return repos.map((repo): DoctorCheck => {
      const label = repo['label'] as string;
      const path = repo['path'] as string;
      const checkName = `repos:${label}`;

      if (!existsSync(path)) {
        return {
          name: checkName,
          status: 'warn',
          message: `Repo path missing: ${path}`,
          remediation: `Re-add the repository or update its path`,
        };
      }

      if (!existsSync(`${path}/.git`)) {
        return {
          name: checkName,
          status: 'warn',
          message: `Path exists but is not a git repo: ${path}`,
          remediation: `Verify that ${path} is still a git repository`,
        };
      }

      return { name: checkName, status: 'pass', message: `${label}: ${path}` };
    });
  }
}
