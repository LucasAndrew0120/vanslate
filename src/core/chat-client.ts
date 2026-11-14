import type { ChatRequest, ChatResponse } from "./types";
import { buildReasoningParams, normalizeUsage, readableError } from "./utils";

export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export type Sleep = (ms: number) => Promise<void>;

/**
 * Assembles the Chat Completions request body. Reasoning/thinking fields are
 * only added when the caller passes an explicit ReasoningSettings object, so
 * the default request stays compatible with any OpenAI-compatible endpoint.
 */
export function buildChatRequestBody(request: ChatRequest): Record<string, unknown> {
  return {
    model: request.model,
    temperature: request.temperature,
    messages: request.messages,
    ...buildReasoningParams(request.reasoning, request.endpoint, request.model)
  };
}

const REASONING_BODY_KEYS = ["thinking", "enable_thinking", "reasoning_effort"] as const;

/**
 * Some OpenAI-compatible gateways reject unknown reasoning fields with HTTP 400
 * instead of ignoring them. When the failure message names one of the fields we
 * injected, return a body without them so the caller can retry safely.
 */
export function stripRejectedReasoningParams(
  body: Record<string, unknown>,
  error: unknown
): Record<string, unknown> | null {
  const status = Number((error as Record<string, unknown>)?.status) || 0;
  if (status && status !== 400 && status !== 422) return null;
  const message = readableError(error).toLowerCase();
  const rejected = REASONING_BODY_KEYS.filter((key) => key in body && message.includes(key));
  if (!rejected.length) return null;
  const fallback = { ...body };
  rejected.forEach((key) => {
    delete fallback[key];
  });
  return fallback;
}

export class OpenAICompatibleChatClient implements ChatClient {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly sleepImpl: Sleep = sleep,
    private readonly retryBaseDelayMs = 1000
  ) {}

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const payload = await this.postChat(request);

    const message = (payload as any)?.choices?.[0]?.message || {};
    return {
      message,
      content: String(message.content || "").trim(),
      usage: normalizeUsage((payload as any)?.usage),
      raw: payload
    };
  }

  private async postChat(request: ChatRequest): Promise<unknown> {
    const body = buildChatRequestBody(request);
    try {
      return await this.fetchJsonWithRetry(request.endpoint, this.requestInit(request, body), request.retryCount);
    } catch (error) {
      const fallbackBody = stripRejectedReasoningParams(body, error);
      if (!fallbackBody) throw error;
      return this.fetchJsonWithRetry(
        request.endpoint,
        this.requestInit(request, fallbackBody),
        Math.min(request.retryCount, 1)
      );
    }
  }

  private requestInit(request: ChatRequest, body: Record<string, unknown>): RequestInit {
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${request.apiKey}`
      },
      body: JSON.stringify(body)
    };
  }

  private async fetchJsonWithRetry(endpoint: string, request: RequestInit, retryCount: number): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        const response = await this.fetchImpl(endpoint, request);
        const payload = await response.json().catch(() => null);
        if (response.ok) return payload;

        const message = (payload as any)?.error?.message || `${response.status} ${response.statusText}`;
        const error = new Error(`API request failed: ${message}`) as Error & { status?: number; retryAfter?: number };
        error.status = response.status;
        error.retryAfter = Number(response.headers.get("retry-after")) || 0;
        throw error;
      } catch (error) {
        lastError = error;
        if (attempt >= retryCount || !this.shouldRetry(error)) break;
        await this.sleepImpl(this.retryDelay(error, attempt));
      }
    }
    throw lastError;
  }

  private shouldRetry(error: unknown): boolean {
    const record = error as Record<string, unknown>;
    if (record?.status === 429) return true;
    if (Number(record?.status) >= 500) return true;
    return /timeout|network|failed to fetch/i.test(readableError(error));
  }

  private retryDelay(error: unknown, attempt: number): number {
    const retryAfter = Number((error as Record<string, unknown>)?.retryAfter) || 0;
    if (retryAfter > 0) return Math.min(retryAfter * 1000, 15000);
    return Math.min(this.retryBaseDelayMs * 2 ** attempt, 8000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
