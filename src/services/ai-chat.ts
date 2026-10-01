import { z } from 'zod';
import { basename } from 'path';
import type {
  AgentCLI,
  AIChatConfig,
  BoardSnapshot,
  ChatContext,
  ChatMessage,
  ChatToolExecution,
  ChatTurnParams,
  ChatTurnResult,
  FilterModel,
  RepoRecord,
  TaskRecord,
  TrackRecord,
} from '../types/index.js';
import type { BoardService } from './board.js';
import type { WorkspaceService } from './workspace.js';
import type { WorktreeService } from './worktree.js';
import type { SessionManager } from './session-manager.js';
import type { SyncService } from './sync.js';
import type { GitService, GitWorkspaceStatus } from './git.js';
import type { ViewService } from './view.js';
import type { EventLogService } from './events.js';
import type { GitHubService } from './github.js';
import type {
  ChatCompletionResult,
  ChatModelClient,
  ChatModelMessage,
  ChatToolCall,
  ChatToolSchema,
  ManagedOllamaService,
} from './ollama.js';
import { OllamaClient } from './ollama.js';

const toolString = z.string().trim().min(1);
const optionalToolString = z.string().trim().min(1).optional();
const optionalPositiveInt = z.number().int().positive().optional();

const createTaskArgsSchema = z.object({
  title: toolString,
  repo: optionalToolString,
  pillar: optionalToolString,
  agentCli: z.enum(['claude', 'codex']).optional(),
  track: optionalToolString,
  /** A general task belongs to no repo: just a title and an agent session. */
  general: z.boolean().optional(),
});

const moveTaskArgsSchema = z.object({
  task: toolString,
  track: toolString,
});

const assignPillarArgsSchema = z.object({
  task: toolString,
  pillar: toolString,
});

const updateTaskDescriptionArgsSchema = z.object({
  task: toolString,
  description: toolString,
});

const taskRefArgsSchema = z.object({
  task: optionalToolString,
});

const commentTaskPRArgsSchema = z.object({
  task: toolString,
  body: toolString,
});

const findTasksArgsSchema = z.object({
  query: optionalToolString,
  repo: optionalToolString,
  pillar: optionalToolString,
  track: optionalToolString,
  limit: optionalPositiveInt,
});

const getRecentTerminalOutputArgsSchema = z.object({
  task: optionalToolString,
  lineCount: optionalPositiveInt,
});

const requiredTaskRefArgsSchema = z.object({
  task: toolString,
});

interface AIChatServiceDeps {
  board: BoardService;
  workspace: WorkspaceService;
  worktrees: WorktreeService;
  session: Pick<SessionManager, 'openSession' | 'inspectSessionState' | 'getBuffer'>;
  sync: Pick<SyncService, 'createTaskPR' | 'schedulePostPushSync' | 'trigger'>;
  github: Pick<GitHubService, 'commentPR' | 'mergePR'>;
  git: Pick<
    GitService,
    | 'ensureBranch'
    | 'getWorkspaceStatus'
    | 'fetch'
    | 'rebaseOnto'
    | 'pushCurrentBranch'
  >;
  view: ViewService;
  events: EventLogService;
  config: AIChatConfig;
  ollama?: Pick<ManagedOllamaService, 'ensureModelReady'>;
  client?: ChatModelClient;
}

interface ToolContext {
  context: ChatContext;
  snapshot: BoardSnapshot;
}

interface ToolOutcome {
  summary: string;
  payload: Record<string, unknown>;
  snapshot: BoardSnapshot;
}

interface ToolSpec<TArgs extends z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: TArgs;
  handler: (args: z.infer<TArgs>, ctx: ToolContext) => Promise<ToolOutcome>;
}

export class AIChatService {
  private readonly client: ChatModelClient;
  private readonly tools: ToolSpec<z.ZodTypeAny>[];

  constructor(private readonly deps: AIChatServiceDeps) {
    this.client = deps.client ?? new OllamaClient(deps.config);
    this.tools = this.buildToolSpecs();
  }

  async chatTurn(params: ChatTurnParams): Promise<ChatTurnResult> {
    this.assertConfigured();
    await this.deps.ollama?.ensureModelReady();

    const prompt = params.prompt.trim();
    if (prompt.length === 0) {
      throw new Error('Chat prompt cannot be empty');
    }

    const executions: ChatToolExecution[] = [];
    const userMessage: ChatMessage = {
      role: 'user',
      content: prompt,
      createdAt: Date.now(),
    };

    let snapshot = this.deps.view.getBoardSnapshot();
    const context = params.context ?? {};
    const messages = this.buildModelMessages(params.transcript ?? [], userMessage, context, snapshot);

    let finalResponse: ChatCompletionResult | null = null;

    for (let round = 0; round <= this.deps.config.maxToolRounds; round += 1) {
      const response = await this.client.chat(messages, this.toolSchemas());
      finalResponse = response;

      if (response.toolCalls.length === 0) {
        break;
      }

      if (round === this.deps.config.maxToolRounds) {
        throw new Error('AI chat exceeded the maximum tool-call rounds');
      }

      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const toolCall of response.toolCalls) {
        const execution = this.startExecution(toolCall);
        executions.push(execution);

        let toolMessage: ChatModelMessage;
        try {
          const outcome = await this.executeToolCall(toolCall, { context, snapshot });
          snapshot = outcome.snapshot;
          execution.status = 'completed';
          execution.finishedAt = Date.now();
          execution.summary = outcome.summary;
          this.deps.events.log('ai.tool.executed', {
            toolName: toolCall.name,
            args: toolCall.arguments,
            status: execution.status,
            summary: execution.summary,
          });
          toolMessage = {
            role: 'tool',
            toolName: toolCall.name,
            content: JSON.stringify({
              ok: true,
              summary: outcome.summary,
              data: outcome.payload,
            }),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          execution.status = 'failed';
          execution.finishedAt = Date.now();
          execution.error = message;
          this.deps.events.log('ai.tool.executed', {
            toolName: toolCall.name,
            args: toolCall.arguments,
            status: execution.status,
            error: message,
          });
          toolMessage = {
            role: 'tool',
            toolName: toolCall.name,
            content: JSON.stringify({
              ok: false,
              error: message,
            }),
          };
        }

        messages.push(toolMessage);
      }
    }

    const assistantText =
      finalResponse?.content.trim() ||
      synthesizeAssistantMessage(executions) ||
      'Done.';
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: assistantText,
      createdAt: Date.now(),
    };

    const transcript = [...(params.transcript ?? []), userMessage, assistantMessage];
    this.deps.events.log('ai.turn.completed', {
      prompt,
      executions: executions.map((execution) => ({
        toolName: execution.toolName,
        status: execution.status,
        summary: execution.summary,
        error: execution.error,
      })),
      assistantPreview: assistantMessage.content.slice(0, 240),
    });

    return {
      assistantMessage,
      transcript,
      executions,
    };
  }

  private assertConfigured(): void {
    if (!this.deps.config.enabled) {
      throw new Error('AI chat is disabled in config.aiChat.enabled');
    }
    if (!this.deps.config.model.trim()) {
      throw new Error('AI chat model is not configured in config.aiChat.model');
    }
  }

  private buildModelMessages(
    transcript: ChatMessage[],
    userMessage: ChatMessage,
    context: ChatContext,
    snapshot: BoardSnapshot,
  ): ChatModelMessage[] {
    const history = transcript
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-this.deps.config.historyLimit)
      .map<ChatModelMessage>((message) => ({
        role: message.role,
        content: message.content,
      }));
    const initialContextMessages =
      transcript.length === 0
        ? [
            {
              role: 'system' as const,
              content: this.initialContextMessage(context, snapshot),
            },
          ]
        : [];

    return [
      {
        role: 'system',
        content: this.systemPrompt(context, snapshot),
      },
      ...initialContextMessages,
      ...history,
      {
        role: 'user',
        content: userMessage.content,
      },
    ];
  }

  private systemPrompt(context: ChatContext, snapshot: BoardSnapshot): string {
    const repoNames =
      snapshot.repos.map((repo) => this.describeRepoForPrompt(repo)).join('; ') ||
      'none';
    const boardTaskLines = this.describeBoardTasksForPrompt(snapshot);
    const pillarNames = snapshot.pillars.map((pillar) => pillar.label).join(', ') || 'none';
    const trackNames = snapshot.tracks.map((track) => track.label).join(', ') || 'none';
    const currentRepo = this.resolveCurrentRepo(context, snapshot);
    const defaultRepo = currentRepo ?? (snapshot.repos.length === 1 ? snapshot.repos[0] : null);
    const defaultPillar = defaultRepo ? this.defaultPillarForRepo(defaultRepo, snapshot) : null;
    const selectedTaskRef = context.selectedTaskId;
    const selectedTask = selectedTaskRef ? this.findTaskById(selectedTaskRef, snapshot) : null;
    const activeTask = context.activeTaskId
      ? this.findTaskById(context.activeTaskId, snapshot)
      : null;

    const parts = [
      this.deps.config.systemPrompt?.trim() ?? '',
      'Runtime context:',
      `Repos: ${repoNames}.`,
      `Current repo selection: ${currentRepo ? this.describeRepoForPrompt(currentRepo) : 'none'}.`,
      `Default repo when omitted: ${defaultRepo ? this.describeRepoForPrompt(defaultRepo) : 'none; ask for clarification if needed'}.`,
      `Task creation defaults: track=backlog, agent=claude, pillar=${defaultPillar?.label ?? 'repo default if configured, otherwise none'}.`,
      `Pillars: ${pillarNames}.`,
      `Tracks: ${trackNames}.`,
      `Board tasks:\n${boardTaskLines.length > 0 ? boardTaskLines.map((line) => `- ${line}`).join('\n') : '- none'}`,
      `Selected task: ${selectedTask?.title ?? selectedTaskRef ?? 'none'}.`,
      `Selected task context: ${selectedTask ? this.describeSelectedTaskContextForPrompt(selectedTask.id, snapshot) : 'none'}.`,
      `Active task: ${activeTask?.title ?? context.activeTaskId ?? 'none'}.`,
    ];

    if (context.filters) {
      parts.push(`Active filters: ${summarizeFilters(context.filters)}.`);
    }

    return parts.filter((part) => part.length > 0).join('\n');
  }

  private initialContextMessage(context: ChatContext, snapshot: BoardSnapshot): string {
    return [
      'Structured runtime context for this AI chat conversation. Use it as ground truth before asking repo or task follow-up questions.',
      JSON.stringify(this.buildCurrentContextPayload({ context, snapshot })),
    ].join('\n');
  }

  private toolSchemas(): ChatToolSchema[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private startExecution(toolCall: ChatToolCall): ChatToolExecution {
    return {
      toolName: toolCall.name,
      args: toolCall.arguments,
      status: 'started',
      startedAt: Date.now(),
    };
  }

  private async executeToolCall(toolCall: ChatToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.find((candidate) => candidate.name === toolCall.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolCall.name}`);
    }

    const parsed = tool.schema.safeParse(toolCall.arguments);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
    }

    return tool.handler(parsed.data, ctx);
  }

  private buildToolSpecs(): ToolSpec<z.ZodTypeAny>[] {
    return [
      {
        name: 'get_current_context',
        description: 'Return the current AgentBoard selection context, repos, pillars, and tracks.',
        parameters: { type: 'object', properties: {} },
        schema: z.object({}).passthrough(),
        handler: async (_args, ctx) => ({
          summary: 'Loaded the current board context.',
          payload: this.buildCurrentContextPayload(ctx),
          snapshot: ctx.snapshot,
        }),
      },
      {
        name: 'find_tasks',
        description: 'Find tasks by title and optional repo, pillar, or track filters.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            repo: { type: 'string' },
            pillar: { type: 'string' },
            track: { type: 'string' },
            limit: { type: 'integer', minimum: 1 },
          },
        },
        schema: findTasksArgsSchema,
        handler: async (args, ctx) => this.findTasks(args, ctx),
      },
      {
        name: 'get_task_session_state',
        description: 'Inspect the selected or named task session activity.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
        schema: taskRefArgsSchema,
        handler: async (args, ctx) => this.getTaskSessionState(args, ctx),
      },
      {
        name: 'get_recent_terminal_output',
        description: 'Read the most recent plain-text lines from the selected or named task terminal.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            lineCount: { type: 'integer', minimum: 1 },
          },
        },
        schema: getRecentTerminalOutputArgsSchema,
        handler: async (args, ctx) => this.getRecentTerminalOutput(args, ctx),
      },
      {
        name: 'create_task',
        description:
          'Create a board task, defaulting to the current repo and backlog. ' +
          'Pass general=true for a standalone card with no repo, branch, or PR.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            repo: { type: 'string' },
            pillar: { type: 'string' },
            agentCli: { type: 'string', enum: ['claude', 'codex'] },
            track: { type: 'string' },
            general: { type: 'boolean' },
          },
          required: ['title'],
        },
        schema: createTaskArgsSchema,
        handler: async (args, ctx) => this.createTask(args, ctx),
      },
      {
        name: 'move_task',
        description: 'Move a task to another track.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            track: { type: 'string' },
          },
          required: ['task', 'track'],
        },
        schema: moveTaskArgsSchema,
        handler: async (args, ctx) => this.moveTask(args, ctx),
      },
      {
        name: 'assign_pillar',
        description: 'Assign a pillar to a task.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            pillar: { type: 'string' },
          },
          required: ['task', 'pillar'],
        },
        schema: assignPillarArgsSchema,
        handler: async (args, ctx) => this.assignPillar(args, ctx),
      },
      {
        name: 'update_task_description',
        description: 'Update the long-form description of a task.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['task', 'description'],
        },
        schema: updateTaskDescriptionArgsSchema,
        handler: async (args, ctx) => this.updateTaskDescription(args, ctx),
      },
      {
        name: 'open_task_session',
        description: 'Open or attach the selected or named task shell session.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
        schema: taskRefArgsSchema,
        handler: async (args, ctx) => this.openTaskSession(args, ctx),
      },
      {
        name: 'create_task_pr',
        description: 'Create or ensure a pull request for the selected or named task.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
        schema: taskRefArgsSchema,
        handler: async (args, ctx) => this.createTaskPR(args, ctx),
      },
      {
        name: 'comment_task_pr',
        description: 'Comment on an open or draft pull request for a task.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['task', 'body'],
        },
        schema: commentTaskPRArgsSchema,
        handler: async (args, ctx) => this.commentTaskPR(args, ctx),
      },
      {
        name: 'merge_task_pr',
        description: 'Merge a task pull request when it is ready.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
        schema: requiredTaskRefArgsSchema,
        handler: async (args, ctx) => this.mergeTaskPR(args, ctx),
      },
      {
        name: 'trigger_sync',
        description: 'Trigger a GitHub sync across the board.',
        parameters: {
          type: 'object',
          properties: {},
        },
        schema: z.object({}).passthrough(),
        handler: async (_args, ctx) => this.triggerSync(ctx),
      },
      {
        name: 'git_status_current_task',
        description: 'Get git status for the selected or named task workspace.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
        schema: taskRefArgsSchema,
        handler: async (args, ctx) => this.gitStatusCurrentTask(args, ctx),
      },
      {
        name: 'git_rebase_current_task_onto_base',
        description: 'Fetch origin and rebase the selected or named task branch onto origin/<base>.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
        schema: taskRefArgsSchema,
        handler: async (args, ctx) => this.gitRebaseCurrentTaskOntoBase(args, ctx),
      },
      {
        name: 'git_push_current_task_branch',
        description: 'Push the selected or named task branch with --set-upstream and schedule post-push sync.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
        schema: taskRefArgsSchema,
        handler: async (args, ctx) => this.gitPushCurrentTaskBranch(args, ctx),
      },
      {
        name: 'git_rebase_and_push_current_task',
        description: 'Rebase the selected or named task branch onto base and then push it.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string' },
          },
        },
        schema: taskRefArgsSchema,
        handler: async (args, ctx) => this.gitRebaseAndPushCurrentTask(args, ctx),
      },
    ];
  }

  private buildCurrentContextPayload(ctx: ToolContext): Record<string, unknown> {
    const selectedTaskRef = ctx.context.selectedTaskId;
    const selectedTask = selectedTaskRef
      ? this.findTaskById(selectedTaskRef, ctx.snapshot)
      : null;
    const activeTask = ctx.context.activeTaskId
      ? this.findTaskById(ctx.context.activeTaskId, ctx.snapshot)
      : null;
    const currentRepo = this.resolveCurrentRepo(ctx.context, ctx.snapshot);
    const defaultRepo = currentRepo ?? (ctx.snapshot.repos.length === 1 ? ctx.snapshot.repos[0] : null);
    const defaultPillar = defaultRepo ? this.defaultPillarForRepo(defaultRepo, ctx.snapshot) : null;
    const selectedTaskRepo = selectedTask
      ? ctx.snapshot.repos.find((candidate) => candidate.id === selectedTask.repoId) ?? null
      : null;
    const selectedTaskTrack = selectedTask
      ? ctx.snapshot.tracks.find((candidate) => candidate.id === selectedTask.trackId) ?? null
      : null;
    const selectedTaskPillar = selectedTask?.pillarId
      ? ctx.snapshot.pillars.find((candidate) => candidate.id === selectedTask.pillarId) ?? null
      : null;

    return {
      currentRepo: currentRepo
        ? {
            id: currentRepo.id,
            label: currentRepo.label,
            path: currentRepo.path,
            aliases: this.repoAliases(currentRepo),
            defaultBaseBranch: currentRepo.defaultBaseBranch,
            defaultPillarId: currentRepo.defaultPillarId ?? null,
          }
        : null,
      defaultRepo: defaultRepo
        ? {
            id: defaultRepo.id,
            label: defaultRepo.label,
            path: defaultRepo.path,
            aliases: this.repoAliases(defaultRepo),
          }
        : null,
      creationDefaults: {
        repoId: defaultRepo?.id ?? null,
        repoLabel: defaultRepo?.label ?? null,
        trackId: 'backlog',
        agentCli: 'claude',
        pillarId: defaultPillar?.id ?? null,
        pillarLabel: defaultPillar?.label ?? null,
      },
      selectedTask: selectedTask
        ? {
            id: selectedTask.id,
            title: selectedTask.title,
            repoId: selectedTask.repoId,
            repoLabel: selectedTaskRepo?.label ?? null,
            trackId: selectedTask.trackId,
            trackLabel: selectedTaskTrack?.label ?? null,
            pillarId: selectedTask.pillarId ?? null,
            pillarLabel: selectedTaskPillar?.label ?? null,
            agentCli: selectedTask.agentCli,
          }
        : null,
      activeTask: activeTask
        ? {
            id: activeTask.id,
            title: activeTask.title,
            trackId: activeTask.trackId,
            branchName: activeTask.branchName ?? null,
          }
        : null,
      repos: ctx.snapshot.repos.map((repo) => ({
        id: repo.id,
        label: repo.label,
        path: repo.path,
        aliases: this.repoAliases(repo),
        defaultBaseBranch: repo.defaultBaseBranch,
        defaultPillarId: repo.defaultPillarId ?? null,
      })),
      tasks: this.allTasks(ctx.snapshot).map((task) => {
        const repo = ctx.snapshot.repos.find((candidate) => candidate.id === task.repoId);
        const track = ctx.snapshot.tracks.find((candidate) => candidate.id === task.trackId);
        const pillar = task.pillarId
          ? ctx.snapshot.pillars.find((candidate) => candidate.id === task.pillarId)
          : null;

        return {
          id: task.id,
          title: task.title,
          repoId: task.repoId,
          repoLabel: repo?.label ?? null,
          trackId: task.trackId,
          trackLabel: track?.label ?? null,
          pillarId: task.pillarId ?? null,
          pillarLabel: pillar?.label ?? null,
          agentCli: task.agentCli,
          prState: task.prState,
          ciState: task.ciState,
        };
      }),
      pillars: ctx.snapshot.pillars.map((pillar) => ({
        id: pillar.id,
        label: pillar.label,
      })),
      tracks: ctx.snapshot.tracks.map((track) => ({
        id: track.id,
        label: track.label,
      })),
    };
  }

  private async findTasks(args: z.infer<typeof findTasksArgsSchema>, ctx: ToolContext): Promise<ToolOutcome> {
    const tasks = this.allTasks(ctx.snapshot).filter((task) => {
      if (args.query) {
        const needle = normalizeRef(args.query);
        if (
          !normalizeRef(task.title).includes(needle) &&
          !normalizeRef(task.id).includes(needle)
        ) {
          return false;
        }
      }

      if (args.repo) {
        const repo = this.resolveRepoRef(args.repo, ctx.context, ctx.snapshot);
        if (task.repoId !== repo.id) {
          return false;
        }
      }

      if (args.pillar) {
        const pillar = this.resolvePillarRef(args.pillar, ctx.snapshot);
        if (task.pillarId !== pillar.id) {
          return false;
        }
      }

      if (args.track) {
        const track = this.resolveTrackRef(args.track, ctx.snapshot);
        if (task.trackId !== track.id) {
          return false;
        }
      }

      return true;
    });

    const limited = tasks.slice(0, Math.min(args.limit ?? 8, 20)).map((task) => ({
      id: task.id,
      title: task.title,
      repoId: task.repoId,
      trackId: task.trackId,
      pillarId: task.pillarId ?? null,
      agentCli: task.agentCli,
      branchName: task.branchName ?? null,
      prState: task.prState,
      ciState: task.ciState,
    }));

    return {
      summary: limited.length === 0 ? 'No matching tasks found.' : `Found ${limited.length} matching task(s).`,
      payload: { tasks: limited },
      snapshot: ctx.snapshot,
    };
  }

  private async getTaskSessionState(
    args: z.infer<typeof taskRefArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const result = await this.deps.session.inspectSessionState(task.id);

    return {
      summary: result.activity
        ? `Loaded session state for ${task.title}.`
        : `No active session was found for ${task.title}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
        },
        session: result.activity,
      },
      snapshot: ctx.snapshot,
    };
  }

  private async getRecentTerminalOutput(
    args: z.infer<typeof getRecentTerminalOutputArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const buffer = await this.deps.session.getBuffer(task.id);
    const lineCount = Math.min(args.lineCount ?? 20, 100);
    const lines = buffer.lines.slice(-lineCount);

    return {
      summary:
        lines.length === 0
          ? `No terminal output is available for ${task.title}.`
          : `Loaded ${lines.length} terminal line(s) for ${task.title}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
        },
        lines,
      },
      snapshot: ctx.snapshot,
    };
  }

  private async createTask(
    args: z.infer<typeof createTaskArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const isGeneral = args.general === true;
    const repo = isGeneral ? null : this.resolveRepoRef(args.repo, ctx.context, ctx.snapshot);
    const pillar = args.pillar
      ? this.resolvePillarRef(args.pillar, ctx.snapshot)
      : repo
        ? this.defaultPillarForRepo(repo, ctx.snapshot)
        : undefined;
    const track = args.track ? this.resolveTrackRef(args.track, ctx.snapshot) : { id: 'backlog' };

    const task = this.deps.board.createTask({
      title: args.title,
      kind: isGeneral ? 'general' : 'repo',
      repoId: repo?.id,
      pillarId: pillar?.id,
      agentCli: (args.agentCli ?? 'claude') as AgentCLI,
      trackId: track.id,
    });
    const snapshot = this.deps.view.getBoardSnapshot();

    return {
      summary: isGeneral ? `Created general task ${task.title}.` : `Created task ${task.title}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
          kind: task.kind,
          repoId: task.repoId ?? null,
          pillarId: task.pillarId ?? null,
          trackId: task.trackId,
          agentCli: task.agentCli,
        },
      },
      snapshot,
    };
  }

  private async moveTask(
    args: z.infer<typeof moveTaskArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const track = this.resolveTrackRef(args.track, ctx.snapshot);
    this.deps.board.moveTask({ id: task.id, trackId: track.id });
    const snapshot = this.deps.view.getBoardSnapshot();

    return {
      summary: `Moved ${task.title} to ${track.label}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
          trackId: track.id,
        },
      },
      snapshot,
    };
  }

  private async assignPillar(
    args: z.infer<typeof assignPillarArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const pillar = this.resolvePillarRef(args.pillar, ctx.snapshot);
    this.deps.board.assignPillar(task.id, pillar.id);
    const snapshot = this.deps.view.getBoardSnapshot();

    return {
      summary: `Assigned pillar ${pillar.label} to ${task.title}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
          pillarId: pillar.id,
        },
      },
      snapshot,
    };
  }

  private async updateTaskDescription(
    args: z.infer<typeof updateTaskDescriptionArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    this.deps.board.setTaskDescription(task.id, args.description);
    const snapshot = this.deps.view.getBoardSnapshot();

    return {
      summary: `Updated the description for ${task.title}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
          description: args.description,
        },
      },
      snapshot,
    };
  }

  private async openTaskSession(
    args: z.infer<typeof taskRefArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const session = await this.deps.session.openSession(task.id);
    const snapshot = this.deps.view.getBoardSnapshot();

    return {
      summary: `Opened a shell for ${task.title}.`,
      payload: {
        session: {
          id: session.id,
          taskId: session.taskId,
          backendType: session.backendType,
          cwd: session.cwd ?? null,
          branch: session.branch ?? null,
        },
      },
      snapshot,
    };
  }

  private async createTaskPR(
    args: z.infer<typeof taskRefArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const pr = await this.deps.sync.createTaskPR(task.id);
    const snapshot = this.deps.view.getBoardSnapshot();

    return {
      summary: `Ensured a pull request for ${task.title}.`,
      payload: {
        pr,
      },
      snapshot,
    };
  }

  private async commentTaskPR(
    args: z.infer<typeof commentTaskPRArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    if (task.prState !== 'open' && task.prState !== 'draft') {
      throw new Error(`Task ${task.title} does not have an open or draft PR`);
    }
    if (task.prNumber == null) {
      throw new Error(`Task ${task.title} has no PR number`);
    }

    const repo = this.deps.workspace.getRepo(task.repoId);
    if (!repo?.githubOwner || !repo.githubRepo) {
      throw new Error(`Repo ${repo?.label ?? task.repoId} is missing GitHub identity`);
    }

    await this.deps.github.commentPR(repo.path, {
      githubRepo: `${repo.githubOwner}/${repo.githubRepo}`,
      prNumber: task.prNumber,
      body: args.body,
    });

    return {
      summary: `Commented on PR #${task.prNumber} for ${task.title}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
          prNumber: task.prNumber,
        },
      },
      snapshot: this.deps.view.getBoardSnapshot(),
    };
  }

  private async mergeTaskPR(
    args: z.infer<typeof requiredTaskRefArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    if (task.prNumber == null) {
      throw new Error(`Task ${task.title} has no PR number`);
    }
    if (task.prState !== 'open') {
      throw new Error(`Task ${task.title} does not have an open PR`);
    }
    if (task.ciState !== 'passed') {
      throw new Error(`Task ${task.title} build has not passed`);
    }
    if (task.reviewState !== 'approved') {
      throw new Error(`Task ${task.title} is not approved`);
    }

    const repo = this.deps.workspace.getRepo(task.repoId);
    if (!repo?.githubOwner || !repo.githubRepo) {
      throw new Error(`Repo ${repo?.label ?? task.repoId} is missing GitHub identity`);
    }

    await this.deps.github.mergePR(repo.path, {
      githubRepo: `${repo.githubOwner}/${repo.githubRepo}`,
      prNumber: task.prNumber,
    });

    this.deps.board.updateTaskSync(task.id, {
      prState: 'merged',
      prDraft: false,
    });
    if (task.trackId !== 'done') {
      this.deps.board.moveTask({ id: task.id, trackId: 'done' });
    }
    void this.deps.sync.trigger().catch(() => {});

    return {
      summary: `Merged PR #${task.prNumber} for ${task.title}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
          prNumber: task.prNumber,
        },
      },
      snapshot: this.deps.view.getBoardSnapshot(),
    };
  }

  private async triggerSync(_ctx: ToolContext): Promise<ToolOutcome> {
    const result = await this.deps.sync.trigger();
    const snapshot = this.deps.view.getBoardSnapshot();
    return {
      summary: 'Triggered board sync.',
      payload: {
        tasksUpdated: result.tasksUpdated,
        errors: result.errors,
      },
      snapshot,
    };
  }

  private async gitStatusCurrentTask(
    args: z.infer<typeof taskRefArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const status = await this.loadTaskWorkspaceStatus(task);
    const snapshot = this.deps.view.getBoardSnapshot();

    return {
      summary: `Loaded git status for ${task.title}.`,
      payload: {
        task: {
          id: task.id,
          title: task.title,
          branchName: task.branchName ?? null,
        },
        status,
      },
      snapshot,
    };
  }

  private async gitRebaseCurrentTaskOntoBase(
    args: z.infer<typeof taskRefArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const { task: refreshedTask, repo, workspacePath } = await this.prepareTaskWorkspace(task);
    const status = await this.deps.git.getWorkspaceStatus(workspacePath);
    this.assertSafeForRebase(refreshedTask, status);

    await this.deps.git.fetch(workspacePath, 'origin');
    await this.deps.git.rebaseOnto(workspacePath, `origin/${repo.defaultBaseBranch}`);

    const nextStatus = await this.refreshTaskGitStatus(refreshedTask.id, workspacePath);
    const snapshot = this.deps.view.getBoardSnapshot();
    return {
      summary: `Rebased ${refreshedTask.title} onto origin/${repo.defaultBaseBranch}.`,
      payload: {
        task: {
          id: refreshedTask.id,
          title: refreshedTask.title,
          branchName: refreshedTask.branchName ?? null,
        },
        status: nextStatus,
      },
      snapshot,
    };
  }

  private async gitPushCurrentTaskBranch(
    args: z.infer<typeof taskRefArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const task = this.resolveTaskRef(args.task, ctx.context, ctx.snapshot);
    const { task: refreshedTask, workspacePath } = await this.prepareTaskWorkspace(task);
    const branch = refreshedTask.branchName;
    if (!branch) {
      throw new Error(`Task ${refreshedTask.title} has no branch`);
    }

    await this.deps.git.pushCurrentBranch(workspacePath, branch, 'origin', true);
    this.deps.sync.schedulePostPushSync(refreshedTask.id);

    const nextStatus = await this.refreshTaskGitStatus(refreshedTask.id, workspacePath);
    const snapshot = this.deps.view.getBoardSnapshot();
    return {
      summary: `Pushed ${refreshedTask.title} to origin/${branch}.`,
      payload: {
        task: {
          id: refreshedTask.id,
          title: refreshedTask.title,
          branchName: branch,
        },
        status: nextStatus,
      },
      snapshot,
    };
  }

  private async gitRebaseAndPushCurrentTask(
    args: z.infer<typeof taskRefArgsSchema>,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const rebase = await this.gitRebaseCurrentTaskOntoBase(args, ctx);
    const push = await this.gitPushCurrentTaskBranch(args, {
      ...ctx,
      snapshot: rebase.snapshot,
    });
    return {
      summary: `${rebase.summary} ${push.summary}`,
      payload: {
        rebase: rebase.payload,
        push: push.payload,
      },
      snapshot: push.snapshot,
    };
  }

  private async prepareTaskWorkspace(task: TaskRecord): Promise<{
    task: TaskRecord;
    repo: RepoRecord;
    workspacePath: string;
  }> {
    const repo = this.deps.workspace.getRepo(task.repoId);
    if (!repo) {
      throw new Error(`Repo not found for task ${task.title}`);
    }

    const workspace = await this.deps.worktrees.prepareTaskWorkspace(task.id);
    const refreshedTask = this.deps.board.getTask(task.id);
    if (!refreshedTask) {
      throw new Error(`Task not found: ${task.id}`);
    }
    if (!refreshedTask.branchName) {
      throw new Error(`Task ${refreshedTask.title} has no branch`);
    }

    this.deps.git.ensureBranch(workspace.path, refreshedTask.branchName, repo.defaultBaseBranch);
    return {
      task: refreshedTask,
      repo,
      workspacePath: workspace.path,
    };
  }

  private async loadTaskWorkspaceStatus(task: TaskRecord): Promise<GitWorkspaceStatus> {
    const { workspacePath } = await this.prepareTaskWorkspace(task);
    return this.refreshTaskGitStatus(task.id, workspacePath);
  }

  private async refreshTaskGitStatus(taskId: string, workspacePath: string): Promise<GitWorkspaceStatus> {
    const status = await this.deps.git.getWorkspaceStatus(workspacePath);
    this.deps.board.updateTaskSync(taskId, {
      gitState: status.gitState,
      gitAheadCount: status.aheadCount,
      gitBehindCount: status.behindCount,
      hasUntracked: status.hasUntracked,
      hasConflicts: status.hasConflicts,
    });
    return status;
  }

  private assertSafeForRebase(task: TaskRecord, status: GitWorkspaceStatus): void {
    if (status.gitState === 'dirty') {
      throw new Error(`Task ${task.title} has tracked changes; commit or stash them before rebasing`);
    }
    if (status.gitState === 'conflicted' || status.hasConflicts) {
      throw new Error(`Task ${task.title} has merge conflicts and cannot be rebased automatically`);
    }
    if (status.gitState === 'detached') {
      throw new Error(`Task ${task.title} is in detached HEAD state`);
    }
  }

  private resolveRepoRef(ref: string | undefined, context: ChatContext, snapshot: BoardSnapshot): RepoRecord {
    if (!ref) {
      const currentRepo = this.resolveCurrentRepo(context, snapshot);
      if (currentRepo) {
        return currentRepo;
      }
      if (snapshot.repos.length === 1) {
        return snapshot.repos[0];
      }
      throw new Error('Repo is ambiguous; specify a repo name');
    }

    return resolveOne(ref, snapshot.repos, (repo) => this.repoAliases(repo), 'repo');
  }

  private resolveCurrentRepo(context: ChatContext, snapshot: BoardSnapshot): RepoRecord | null {
    if (context.activeRepoId) {
      return snapshot.repos.find((repo) => repo.id === context.activeRepoId) ?? null;
    }

    const selectedTask = context.selectedTaskId
      ? this.findTaskById(context.selectedTaskId, snapshot)
      : null;
    if (selectedTask) {
      return snapshot.repos.find((repo) => repo.id === selectedTask.repoId) ?? null;
    }

    return null;
  }

  private resolvePillarRef(ref: string, snapshot: BoardSnapshot) {
    return resolveOne(ref, snapshot.pillars, (pillar) => [pillar.id, pillar.label], 'pillar');
  }

  private defaultPillarForRepo(repo: RepoRecord, snapshot: BoardSnapshot) {
    if (!repo.defaultPillarId) {
      return null;
    }
    return snapshot.pillars.find((pillar) => pillar.id === repo.defaultPillarId) ?? null;
  }

  private repoAliases(repo: RepoRecord): string[] {
    const aliases = new Set<string>();
    const base = basename(repo.path);

    for (const value of [
      repo.id,
      repo.label,
      repo.path,
      base,
      repo.githubRepo,
      repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : undefined,
    ]) {
      if (!value) {
        continue;
      }
      collectAliasVariants(aliases, value);
    }

    collectSemanticRepoAliases(aliases, repo);
    pruneRepoAliases(aliases, repo);

    return Array.from(aliases);
  }

  private describeRepoForPrompt(repo: RepoRecord): string {
    return `${repo.label} (id: ${repo.id}, path: ${repo.path}, aliases: ${this.repoAliases(repo).join(', ')})`;
  }

  private describeBoardTasksForPrompt(snapshot: BoardSnapshot): string[] {
    return this.allTasks(snapshot).map((task) => {
      const repo = snapshot.repos.find((candidate) => candidate.id === task.repoId);
      const track = snapshot.tracks.find((candidate) => candidate.id === task.trackId);
      const pillar = task.pillarId
        ? snapshot.pillars.find((candidate) => candidate.id === task.pillarId)
        : null;

      return `${task.title} [id=${task.id}, repo=${repo?.label ?? task.repoId}, track=${track?.label ?? task.trackId}, pillar=${pillar?.label ?? 'none'}, agent=${task.agentCli}, pr=${task.prState}, ci=${task.ciState}]`;
    });
  }

  private resolveTrackRef(ref: string, snapshot: BoardSnapshot): TrackRecord {
    return resolveOne(ref, snapshot.tracks, (track) => [track.id, track.label], 'track');
  }

  private resolveTaskRef(
    ref: string | undefined,
    context: ChatContext,
    snapshot: BoardSnapshot,
  ): TaskRecord {
    const tasks = this.allTasks(snapshot);
    if (!ref) {
      const preferredId = context.activeTaskId ?? context.selectedTaskId;
      if (preferredId) {
        const task = tasks.find((candidate) => candidate.id === preferredId);
        if (task) {
          return task;
        }
      }
      throw new Error('Task is ambiguous; specify a task title');
    }

    return resolveOne(ref, tasks, (task) => [task.id, task.title], 'task');
  }

  private allTasks(snapshot: BoardSnapshot): TaskRecord[] {
    return snapshot.tasks;
  }

  private findTaskById(taskId: string, snapshot: BoardSnapshot): TaskRecord | null {
    return this.allTasks(snapshot).find((task) => task.id === taskId) ?? null;
  }

  private describeSelectedTaskContextForPrompt(taskId: string, snapshot: BoardSnapshot): string {
    const task = this.findTaskById(taskId, snapshot);
    if (!task) {
      return 'none';
    }

    const repo = snapshot.repos.find((candidate) => candidate.id === task.repoId);
    const track = snapshot.tracks.find((candidate) => candidate.id === task.trackId);
    const pillar = task.pillarId
      ? snapshot.pillars.find((candidate) => candidate.id === task.pillarId)
      : null;

    return [
      `repo=${repo?.label ?? task.repoId}`,
      `track=${track?.label ?? task.trackId}`,
      `pillar=${pillar?.label ?? 'none'}`,
    ].join(', ');
  }
}

function resolveOne<T>(
  ref: string,
  values: T[],
  keys: (value: T) => string[],
  label: string,
): T {
  const normalized = normalizeRef(ref);
  const exact = values.filter((value) =>
    keys(value).some((key) => normalizeRef(key) === normalized),
  );
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw new Error(`Ambiguous ${label}: ${ref}`);
  }

  const fuzzy = values.filter((value) =>
    keys(value).some((key) => normalizeRef(key).includes(normalized)),
  );
  if (fuzzy.length === 1) {
    return fuzzy[0];
  }
  if (fuzzy.length > 1) {
    throw new Error(`Ambiguous ${label}: ${ref}`);
  }

  throw new Error(`Unknown ${label}: ${ref}`);
}

function normalizeRef(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function collectAliasVariants(target: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }

  target.add(trimmed);

  const normalized = normalizeRef(trimmed);
  target.add(normalized);

  const slashParts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  for (const part of slashParts) {
    target.add(part);
    target.add(normalizeRef(part));
  }

  const tokenParts = trimmed.split(/[^a-zA-Z0-9]+/).filter((part) => part.length > 0);
  for (const token of tokenParts) {
    target.add(token);
    target.add(normalizeRef(token));
  }
}

function collectSemanticRepoAliases(target: Set<string>, repo: RepoRecord): void {
  const signatures = [
    repo.id,
    repo.label,
    repo.path,
    basename(repo.path),
    repo.githubRepo,
    repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeRef(value));

    const aliasGroups = [
    {
      matches: ['wix-vmr-repo'],
      aliases: ['back', 'back repo', 'backend repo', 'vmr', 'vmr repo'],
    },
    {
      matches: ['web5-marketing-site'],
      aliases: ['front', 'front repo', 'frontend repo'],
    },
    {
      matches: ['web5-cli'],
      aliases: ['cli', 'cli repo'],
    },
    {
      matches: ['canban-cli-4'],
      aliases: ['kanban', 'kanban repo', 'canban'],
    },
  ];

  for (const group of aliasGroups) {
    if (group.matches.some((match) => signatures.some((signature) => signature.includes(match)))) {
      for (const alias of group.aliases) {
        collectAliasVariants(target, alias);
      }
    }
  }
}

function pruneRepoAliases(target: Set<string>, repo: RepoRecord): void {
  const signatures = [
    repo.id,
    repo.label,
    repo.path,
    basename(repo.path),
    repo.githubRepo,
    repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeRef(value));

  if (signatures.some((signature) => signature.includes('canban-cli-4'))) {
    target.delete('cli');
  }
}

function summarizeFilters(filters: FilterModel): string {
  const parts: string[] = [];
  if (filters.repoIds?.length) {
    parts.push(`repos=${filters.repoIds.join(',')}`);
  }
  if (filters.pillarIds?.length) {
    parts.push(`pillars=${filters.pillarIds.join(',')}`);
  }
  if (filters.trackIds?.length) {
    parts.push(`tracks=${filters.trackIds.join(',')}`);
  }
  if (filters.searchText) {
    parts.push(`search=${filters.searchText}`);
  }
  return parts.join(' ') || 'none';
}

function synthesizeAssistantMessage(executions: ChatToolExecution[]): string {
  const completed = executions.filter((execution) => execution.status === 'completed');
  if (completed.length === 0) {
    return '';
  }
  return completed
    .map((execution) => execution.summary)
    .filter((summary): summary is string => Boolean(summary))
    .join(' ');
}
