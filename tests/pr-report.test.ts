import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePrReportHookInput } from '../src/services/pr-report.js';
import { buildSessionBootstrapEnv, prReportHookArgs } from '../src/services/session-bootstrap.js';

function hookPayload(command: string, stdout: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', interrupted: false },
  });
}

describe('parsePrReportHookInput', () => {
  it('reads the PR a `gh pr create` printed', () => {
    // Arrange
    const raw = hookPayload(
      'gh pr create --title "x" --body "y"',
      'https://github.com/wix-private/web5.0-poc/pull/812\n',
    );

    // Act
    const reported = parsePrReportHookInput(raw);

    // Assert
    expect(reported).toEqual([{ owner: 'wix-private', repo: 'web5.0-poc', number: 812 }]);
  });

  it('ignores a PR named only in the command, not in what it printed', () => {
    // Arrange — a body that quotes another PR would otherwise put someone
    // else's work on the card.
    const raw = hookPayload(
      'gh pr create --body "follows https://github.com/org/other/pull/5"',
      'https://github.com/org/proj/pull/9\n',
    );

    // Act
    const reported = parsePrReportHookInput(raw);

    // Assert
    expect(reported).toEqual([{ owner: 'org', repo: 'proj', number: 9 }]);
  });

  it('ignores Bash calls that did not open a PR', () => {
    // Arrange
    const raw = hookPayload('gh pr view 9', 'https://github.com/org/proj/pull/9\n');

    // Act / Assert
    expect(parsePrReportHookInput(raw)).toEqual([]);
  });

  it('returns nothing for a payload it cannot read', () => {
    expect(parsePrReportHookInput('not json')).toEqual([]);
    expect(parsePrReportHookInput(JSON.stringify({ tool_name: 'Edit' }))).toEqual([]);
  });
});

describe('prReportHookArgs', () => {
  it('installs nothing for a CLI whose --settings is unverified, or without a card', () => {
    expect(prReportHookArgs('codex', 'task-1', 'agentboard')).toEqual([]);
    expect(prReportHookArgs('claude', undefined, 'agentboard')).toEqual([]);
    expect(prReportHookArgs('claude', 'task-1', undefined)).toEqual([]);
  });

  it('leaves a general card without the hook', () => {
    // Arrange / Act
    const settings = buildSessionBootstrapEnv({
      taskId: 'task-1',
      taskKind: 'general',
      repoPath: '/home',
      branch: '',
      agentCli: 'claude',
      agentboardCommand: 'agentboard',
    });

    // Assert
    expect(settings).not.toContain('--settings');
  });

  it('runs the CLI only for a Bash call that ran `gh pr create`, and always exits 0', () => {
    // Arrange — the hook's own shell is the filter, so run it for real against
    // a stand-in CLI that records what it was handed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-report-hook-'));
    const record = path.join(dir, 'calls');
    const fakeCli = path.join(dir, 'fake-agentboard');
    fs.writeFileSync(fakeCli, `#!/bin/sh\necho "$@" >> '${record}'\ncat >> '${record}'\nexit 3\n`, {
      mode: 0o755,
    });
    const [flag, json] = prReportHookArgs('claude', 'task-1', fakeCli);
    const hook = JSON.parse(json!).hooks.PostToolUse[0];
    const run = (payload: string) =>
      spawnSync('/bin/sh', ['-c', hook.hooks[0].command], { input: payload, encoding: 'utf8' });

    // Act
    const unrelated = run(hookPayload('ls -la', 'total 0\n'));
    const created = run(hookPayload('gh pr create --fill', 'https://github.com/org/proj/pull/9\n'));

    // Assert
    expect(flag).toBe('--settings');
    expect(hook.matcher).toBe('Bash');
    expect(unrelated.status).toBe(0);
    expect(created.status).toBe(0);
    const calls = fs.readFileSync(record, 'utf8');
    expect(calls.startsWith('task report-pr task-1\n')).toBe(true);
    expect(calls).toContain('/pull/9');
    expect(calls).not.toContain('ls -la');
  });
});
