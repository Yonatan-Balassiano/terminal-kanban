import { spawn, type ChildProcess } from 'child_process';
import type { AIChatConfig } from '../types/index.js';

export interface ChatToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ChatToolCall[];
  toolName?: string;
}

export interface ChatCompletionResult {
  content: string;
  toolCalls: ChatToolCall[];
}

export interface ChatModelClient {
  chat(messages: ChatModelMessage[], tools: ChatToolSchema[]): Promise<ChatCompletionResult>;
}

const MODEL_WARM_KEEP_ALIVE_SECONDS = 300;
const MODEL_WARM_TTL_MS = MODEL_WARM_KEEP_ALIVE_SECONDS * 1000;
const MODEL_WARM_TTL_BUFFER_MS = 5_000;

export class ManagedOllamaService {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private warming: Promise<void> | null = null;
  private modelWarmUntil = 0;

  constructor(private readonly config: AIChatConfig) {}

  async ensureAvailable(): Promise<void> {
    if (await this.isReachable()) {
      return;
    }

    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startManagedProcess();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async ensureModelReady(): Promise<void> {
    if (!this.config.enabled || !this.config.model.trim()) {
      return;
    }

    await this.ensureAvailable();

    if (Date.now() < this.modelWarmUntil) {
      return;
    }

    if (this.warming) {
      return this.warming;
    }

    this.warming = this.warmModel();
    try {
      await this.warming;
    } finally {
      this.warming = null;
    }
  }

  async shutdown(): Promise<{ stopped: boolean; managed: boolean }> {
    const child = this.child;
    this.modelWarmUntil = 0;
    if (!child || child.exitCode !== null || child.killed) {
      this.child = null;
      return { stopped: false, managed: false };
    }

    this.child = null;
    await terminateChild(child);
    return { stopped: true, managed: true };
  }

  private async startManagedProcess(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      await this.waitUntilReachable(15_000, this.child);
      return;
    }

    const env = { ...process.env };
    const host = this.ollamaHostEnv();
    if (host) {
      env.OLLAMA_HOST = host;
    }

    const child = spawn('ollama', ['serve'], {
      env,
      stdio: 'ignore',
      windowsHide: true,
    });

    let spawnError: Error | null = null;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('exit', () => {
      this.modelWarmUntil = 0;
      if (this.child === child) {
        this.child = null;
      }
    });
    this.child = child;

    try {
      await this.waitUntilReachable(15_000, child, () => spawnError);
    } catch (error) {
      await terminateChild(child);
      if (this.child === child) {
        this.child = null;
      }
      throw error;
    }
  }

  private async waitUntilReachable(
    timeoutMs: number,
    child: ChildProcess | null,
    getSpawnError?: () => Error | null,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const spawnError = getSpawnError?.();
      if (spawnError) {
        throw new Error(`Failed to start Ollama: ${spawnError.message}`);
      }
      if (child && child.exitCode !== null) {
        throw new Error(`Managed Ollama exited before becoming ready (code ${child.exitCode})`);
      }
      if (await this.isReachable()) {
        return;
      }
      await sleep(250);
    }

    throw new Error('Managed Ollama did not become ready before timeout');
  }

  private async warmModel(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(this.endpoint('/api/chat'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model.trim(),
          stream: false,
          keep_alive: MODEL_WARM_KEEP_ALIVE_SECONDS,
        }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => null)) as OllamaChatResponse | null;
      if (!response.ok) {
        throw new Error(
          payload?.error?.trim() || `Ollama model warmup failed with ${response.status}`,
        );
      }
      if (payload?.error) {
        throw new Error(payload.error);
      }

      this.modelWarmUntil = Date.now() + MODEL_WARM_TTL_MS - MODEL_WARM_TTL_BUFFER_MS;
    } catch (error) {
      this.modelWarmUntil = 0;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Ollama model warmup timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async isReachable(): Promise<boolean> {
    for (const path of ['/api/version', '/api/tags']) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);

      try {
        const response = await fetch(this.endpoint(path), {
          method: 'GET',
          signal: controller.signal,
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // Keep probing until the deadline expires.
      } finally {
        clearTimeout(timer);
      }
    }

    return false;
  }

  private endpoint(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private ollamaHostEnv(): string | null {
    try {
      const url = new URL(this.config.baseUrl);
      return url.host || null;
    } catch {
      return null;
    }
  }
}

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  error?: string;
}

export class OllamaClient implements ChatModelClient {
  constructor(private readonly config: AIChatConfig) {}

  async chat(messages: ChatModelMessage[], tools: ChatToolSchema[]): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          messages: messages.map((message) => this.toOllamaMessage(message)),
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed with ${response.status}`);
      }

      const payload = (await response.json()) as OllamaChatResponse;
      if (payload.error) {
        throw new Error(payload.error);
      }

      const toolCalls = (payload.message?.tool_calls ?? []).map((call, index) => ({
        id: `ollama-tool-${Date.now()}-${index}`,
        name: String(call.function?.name ?? '').trim(),
        arguments: normalizeToolArguments(call.function?.arguments),
      }));

      return {
        content: payload.message?.content?.trim() ?? '',
        toolCalls,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Ollama request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private toOllamaMessage(message: ChatModelMessage): Record<string, unknown> {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: message.role,
        content: message.content,
        tool_calls: message.toolCalls.map((toolCall) => ({
          function: {
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
        })),
      };
    }

    if (message.role === 'tool') {
      return {
        role: 'tool',
        name: message.toolName,
        content: message.content,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  }
}

function normalizeToolArguments(value: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  return value;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }

  if (await waitForExit(child, 5_000)) {
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }

  await waitForExit(child, 2_000);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('close', onExit);
    };

    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
