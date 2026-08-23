import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import { BoardService } from '../src/services/board.js';
import { ViewService } from '../src/services/view.js';
import { WorkspaceService } from '../src/services/workspace.js';
import { EventLogService } from '../src/services/events.js';
import { AIChatService } from '../src/services/ai-chat.js';
import { DEFAULT_AI_CHAT_SYSTEM_PROMPT } from '../src/prompts/ai-chat-system-prompt.js';
import type { AIChatConfig, ChatContext, SessionRecord } from '../src/types/index.js';
import type {
  ChatCompletionResult,
  ChatModelClient,
  ChatModelMessage,
  ChatToolSchema,
} from '../src/services/ollama.js';

class FakeChatClient implements ChatModelClient {
  constructor(private readonly results: ChatCompletionResult[]) {}

  async chat(_messages: ChatModelMessage[], _tools: ChatToolSchema[]): Promise<ChatCompletionResult> {
    const next = this.results.shift();
    if (!next) {
      throw new Error('No queued chat result');
    }
    return next;
  }
}

class RecordingChatClient extends FakeChatClient {
  readonly calls: Array<{ messages: ChatModelMessage[]; tools: ChatToolSchema[] }> = [];

  override async chat(messages: ChatModelMessage[], tools: ChatToolSchema[]): Promise<ChatCompletionResult> {
    this.calls.push({ messages, tools });
    return super.chat(messages, tools);
  }
}

describe('AIChatService', () => {
  let db: Db;
  let board: BoardService;
  let view: ViewService;
  let workspace: WorkspaceService;
  let events: EventLogService;
  let aiChatConfig: AIChatConfig;

  beforeEach(() => {
    db = openDb(':memory:');
    board = new BoardService(db);
    view = new ViewService(board);
    workspace = new WorkspaceService(db);
    events = new EventLogService(db);
    aiChatConfig = {
      enabled: true,
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'test-model',
      requestTimeoutMs: 10_000,
      maxToolRounds: 6,
      historyLimit: 12,
    };

    for (const track of [
      { id: 'backlog', label: 'Backlog', sortOrder: 0 },
      { id: 'in-progress', label: 'In Progress', sortOrder: 1 },
      { id: 'pr', label: 'PR', sortOrder: 2 },
      { id: 'done', label: 'Done', sortOrder: 3 },
    ]) {
      board.upsertTrack(track.id, track.label, track.sortOrder);
    }

    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-1', 'Repo', '/tmp/repo-1', 'owner', 'repo', 'main', null, 'ok', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  function makeService(
    client: ChatModelClient,
    overrides: Partial<ChatContext> = {},
    options: {
      ollama?: { ensureModelReady: () => Promise<void> };
    } = {},
  ) {
    const schedulePostPushSync = vi.fn().mockReturnValue({ scheduled: true });
    const triggerSync = vi.fn().mockResolvedValue({ tasksUpdated: 0, errors: [] });
    const git = {
      ensureBranch: vi.fn(),
      getWorkspaceStatus: vi
        .fn()
        .mockResolvedValueOnce({
          branch: 'ab/task-1',
          gitState: 'clean',
          aheadCount: 0,
          behindCount: 0,
          hasUntracked: false,
          hasConflicts: false,
        })
        .mockResolvedValue({
          branch: 'ab/task-1',
          gitState: 'clean',
          aheadCount: 1,
          behindCount: 0,
          hasUntracked: false,
          hasConflicts: false,
        }),
      fetch: vi.fn().mockResolvedValue(undefined),
      rebaseOnto: vi.fn().mockResolvedValue(undefined),
      pushCurrentBranch: vi.fn().mockResolvedValue(undefined),
    };

    const service = new AIChatService({
      board,
      workspace,
      worktrees: {
        prepareTaskWorkspace(taskId: string) {
          return {
            taskId,
            path: `/tmp/workspaces/${taskId}`,
            repoPath: '/tmp/repo-1',
            usedWorktree: false,
          };
        },
      },
      session: {
        async openSession(taskId: string): Promise<SessionRecord> {
          return {
            id: `session-${taskId}`,
            taskId,
            backendType: 'pty',
            backendSessionId: `pty-${taskId}`,
            status: 'active',
            cwd: `/tmp/workspaces/${taskId}`,
            branch: board.getTask(taskId)?.branchName,
            createdAt: 1,
            updatedAt: 1,
          };
        },
        async inspectSessionState(taskId: string) {
          return {
            activity: {
              taskId,
              sessionId: `session-${taskId}`,
              sessionStatus: 'active',
              isBusy: false,
              updatedAt: 1,
            },
            attentionChanged: false,
          };
        },
        async getBuffer() {
          return {
            lines: ['git status', 'clean'],
            ansiLines: ['git status', 'clean'],
            cursorX: 0,
            cursorY: 1,
          };
        },
      },
      sync: {
        createTaskPR: vi.fn().mockResolvedValue({
          number: 41,
          title: 'PR',
          url: 'https://example.test/pr/41',
          prState: 'open',
          ciState: 'pending',
          ciRequiredTotal: 0,
          ciRequiredPassed: 0,
          ciRequiredFailed: 0,
          ciRequiredPending: 0,
          reviewState: 'none',
          unresolvedThreadCount: 0,
        }),
        schedulePostPushSync,
        trigger: triggerSync,
      },
      github: {
        commentPR: vi.fn().mockResolvedValue(undefined),
        mergePR: vi.fn().mockResolvedValue(undefined),
      },
      git,
      view,
      events,
      config: aiChatConfig,
      ollama: options.ollama,
      client,
    });

    return {
      service,
      schedulePostPushSync,
      triggerSync,
      git,
      context: {
        activeRepoId: 'repo-1',
        ...overrides,
      } as ChatContext,
    };
  }

  it('waits for the Ollama model to warm before the first chat request', async () => {
    const ensureModelReady = vi.fn().mockResolvedValue(undefined);
    const client = new FakeChatClient([
      {
        content: 'Ready.',
        toolCalls: [],
      },
    ]);
    const { service, context } = makeService(client, {}, { ollama: { ensureModelReady } });

    await service.chatTurn({
      prompt: 'hello',
      context,
    });

    expect(ensureModelReady).toHaveBeenCalledTimes(1);
  });

  it('creates a task in the current repo with a pillar match and codex agent', async () => {
    const pillar = board.createPillar({ label: 'backend' });
    db.prepare('UPDATE repos SET default_pillar_id = ? WHERE id = ?').run(pillar.id, 'repo-1');

    const { service, context } = makeService(
      new FakeChatClient([
        {
          content: '',
          toolCalls: [
            {
              id: '1',
              name: 'create_task',
              arguments: {
                title: 'Implement auth',
                pillar: 'backend',
                agentCli: 'codex',
              },
            },
          ],
        },
        {
          content: 'Task created.',
          toolCalls: [],
        },
      ]),
    );

    await service.chatTurn({
      prompt: 'open a task to the backend with title Implement auth with codex',
      context,
    });

    const tasks = board.getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Implement auth');
    expect(tasks[0].pillarId).toBe(pillar.id);
    expect(tasks[0].agentCli).toBe('codex');
  });

  it('resolves repo aliases like kanban and keeps omitted task fields on defaults', async () => {
    db.prepare('UPDATE repos SET label = ?, path = ? WHERE id = ?').run(
      'Command Center',
      '/tmp/canban-cli-4',
      'repo-1',
    );
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-2', 'Dashboard', '/tmp/dashboard-app', 'owner', 'dashboard', 'main', null, 'ok', 1, 1);

    const { service, context } = makeService(
      new FakeChatClient([
        {
          content: '',
          toolCalls: [
            {
              id: '1',
              name: 'create_task',
              arguments: {
                title: 'document-thinkler',
                repo: 'kanban',
              },
            },
          ],
        },
        {
          content: 'Task created.',
          toolCalls: [],
        },
      ]),
      {
        activeRepoId: 'repo-2',
      },
    );

    await service.chatTurn({
      prompt: 'create task called document-thinkler in kanban',
      context,
    });

    const tasks = board.getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('document-thinkler');
    expect(tasks[0].repoId).toBe('repo-1');
    expect(tasks[0].trackId).toBe('backlog');
    expect(tasks[0].agentCli).toBe('claude');
    expect(tasks[0].pillarId).toBeUndefined();
  });

  it('resolves semantic repo aliases like vmr, front, cli, and kanban', async () => {
    db.prepare('UPDATE repos SET label = ?, path = ?, github_repo = ? WHERE id = ?').run(
      'Backend',
      '/tmp/wix-vmr-repo',
      'wix-vmr-repo',
      'repo-1',
    );
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'repo-2',
      'Frontend',
      '/tmp/web5-marketing-site',
      'owner',
      'web5-marketing-site',
      'main',
      null,
      'ok',
      1,
      1,
    );
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-3', 'CLI', '/tmp/web5-cli', 'owner', 'web5-cli', 'main', null, 'ok', 1, 1);
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-4', 'Kanban', '/tmp/canban-cli-4', 'owner', 'canban-cli-4', 'main', null, 'ok', 1, 1);

    const { service, context } = makeService(
      new FakeChatClient([
        {
          content: '',
          toolCalls: [{ id: '1', name: 'create_task', arguments: { title: 'Backend task', repo: 'vmr' } }],
        },
        {
          content: '',
          toolCalls: [{ id: '2', name: 'create_task', arguments: { title: 'Frontend task', repo: 'front' } }],
        },
        {
          content: '',
          toolCalls: [{ id: '3', name: 'create_task', arguments: { title: 'CLI task', repo: 'cli' } }],
        },
        {
          content: '',
          toolCalls: [{ id: '4', name: 'create_task', arguments: { title: 'Kanban task', repo: 'kanban' } }],
        },
        {
          content: 'Tasks created.',
          toolCalls: [],
        },
      ]),
      {
        activeRepoId: 'repo-4',
      },
    );

    await service.chatTurn({
      prompt: 'create tasks across shorthand repos',
      context,
    });

    const tasks = board.getTasks();
    expect(tasks.map((task) => [task.title, task.repoId])).toEqual([
      ['Backend task', 'repo-1'],
      ['Frontend task', 'repo-2'],
      ['CLI task', 'repo-3'],
      ['Kanban task', 'repo-4'],
    ]);
  });

  it('describes repo aliases and default repo selection in the runtime system prompt', async () => {
    db.prepare('UPDATE repos SET label = ?, path = ?, github_repo = ? WHERE id = ?').run(
      'Command Center',
      '/tmp/canban-cli-4',
      'canban-cli-4',
      'repo-1',
    );
    const boardTask = board.createTask({ title: 'Ship CLI', repoId: 'repo-1', trackId: 'in-progress' });
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-2', 'Dashboard', '/tmp/dashboard-app', 'owner', 'dashboard', 'main', null, 'ok', 1, 1);

    const client = new RecordingChatClient([
      {
        content: 'Ready.',
        toolCalls: [],
      },
    ]);
    aiChatConfig.systemPrompt = DEFAULT_AI_CHAT_SYSTEM_PROMPT;
    const { service } = makeService(client, {
      activeRepoId: 'repo-1',
    });

    await service.chatTurn({
      prompt: 'what repo am i in?',
      context: { activeRepoId: 'repo-1' },
    });

    const systemMessage = client.calls[0]?.messages[0];
    expect(systemMessage?.role).toBe('system');
    expect(systemMessage?.content).toContain('Current repo selection: Command Center');
    expect(systemMessage?.content).toContain('Default repo when omitted: Command Center');
    expect(systemMessage?.content).toContain('aliases:');
    expect(systemMessage?.content).toContain('kanban');
    expect(systemMessage?.content).toContain('Task creation defaults: track=backlog, agent=claude');
    expect(systemMessage?.content).toContain('strip scaffolding or type words');
    expect(systemMessage?.content).toContain("if runtime context shows a repo alias 'vmr'");
    expect(systemMessage?.content).toContain('infer a short faithful title from the request');
    expect(systemMessage?.content).toContain('find_tasks tool');
    expect(systemMessage?.content).toContain('Board tasks:');
    expect(systemMessage?.content).toContain(boardTask.title);
    expect(systemMessage?.content).toContain('repo=Command Center');
    expect(systemMessage?.content).toContain('track=In Progress');
  });

  it('injects structured repos and tasks context on the first chat turn', async () => {
    aiChatConfig.systemPrompt = DEFAULT_AI_CHAT_SYSTEM_PROMPT;
    db.prepare('UPDATE repos SET label = ?, path = ?, github_repo = ? WHERE id = ?').run(
      'Backend',
      '/tmp/wix-vmr-repo',
      'wix-vmr-repo',
      'repo-1',
    );
    board.createTask({ title: 'Board task', repoId: 'repo-1', trackId: 'in-progress' });

    const client = new RecordingChatClient([
      {
        content: 'Ready.',
        toolCalls: [],
      },
    ]);
    const { service } = makeService(client, {
      activeRepoId: 'repo-1',
    });

    await service.chatTurn({
      prompt: 'create a new take on vmr with codex for Shopify Query Alignment',
      context: { activeRepoId: 'repo-1' },
    });

    const structuredContextMessage = client.calls[0]?.messages[1];
    expect(structuredContextMessage?.role).toBe('system');
    expect(structuredContextMessage?.content).toContain('Structured runtime context for this AI chat conversation');
    expect(structuredContextMessage?.content).toContain('"repos"');
    expect(structuredContextMessage?.content).toContain('"tasks"');
    expect(structuredContextMessage?.content).toContain('"aliases"');
    expect(structuredContextMessage?.content).toContain('"vmr"');
    expect(structuredContextMessage?.content).toContain('Board task');
  });

  it('runs rebase and push in the task workspace and schedules post-push sync', async () => {
    const task = board.createTask({ title: 'Ship it', repoId: 'repo-1' });
    const client = new FakeChatClient([
      {
        content: '',
        toolCalls: [{ id: '1', name: 'git_rebase_and_push_current_task', arguments: { task: task.title } }],
      },
      {
        content: 'Rebased and pushed.',
        toolCalls: [],
      },
    ]);
    const { service, context, schedulePostPushSync, git } = makeService(client, {
      selectedTaskId: task.id,
      activeTaskId: task.id,
    });

    const result = await service.chatTurn({
      prompt: 'rebase and push this task',
      context,
    });

    expect(git.ensureBranch).toHaveBeenCalled();
    expect(git.fetch).toHaveBeenCalledTimes(1);
    expect(git.rebaseOnto).toHaveBeenCalledTimes(1);
    expect(git.pushCurrentBranch).toHaveBeenCalledTimes(1);
    expect(schedulePostPushSync).toHaveBeenCalledWith(task.id);
    expect(result.executions[0].status).toBe('completed');
  });

  it('captures ambiguous repo errors as failed tool executions', async () => {
    db.prepare(
      `INSERT INTO repos
         (id, label, path, github_owner, github_repo, default_base_branch,
          default_pillar_id, health, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('repo-2', 'Second Repo', '/tmp/repo-2', 'owner', 'repo2', 'main', null, 'ok', 1, 1);

    const { service } = makeService(
      new FakeChatClient([
        {
          content: '',
          toolCalls: [{ id: '1', name: 'create_task', arguments: { title: 'Ambiguous task' } }],
        },
        {
          content: 'I need you to specify the repo.',
          toolCalls: [],
        },
      ]),
      {
        activeRepoId: '',
      },
    );

    const result = await service.chatTurn({
      prompt: 'create a task',
      context: { activeRepoId: '' },
    });

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0].status).toBe('failed');
    expect(result.executions[0].error).toContain('Repo is ambiguous');
    expect(board.getTasks()).toHaveLength(0);
  });
});
