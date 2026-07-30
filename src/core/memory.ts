import type { BaseLLM } from "./base";
import type { Message } from "./type";

// ─── 接口 ──────────────────────────────────────────────────────

/**
 * Memory 抽象接口。
 * 负责管理对话历史，决定哪些消息发给 LLM（可能压缩/截断）。
 */
export interface BaseMemory {
  /** 添加一条消息。 */
  add(message: Message): void;
  /** 返回所有已存储的消息（未压缩），用于调试/持久化。 */
  getAll(): Message[];
  /** 返回发给 LLM 的消息列表（可能已压缩/截断）。 */
  getMessages(): Promise<Message[]>;
  /** 清空所有记忆。 */
  clear(): void;
}

// ─── 超限判断（独立维度 1：When）──────────────────────────────

/** 判断非 system 消息是否超限。 */
export type LimitChecker = (nonSystem: Message[]) => boolean;

/** 按消息条数判断。 */
export const byCount =
  (max: number): LimitChecker =>
  (msgs) =>
    msgs.length > max;

/** 按 token 估算判断。 */
export const byToken =
  (max: number): LimitChecker =>
  (msgs) =>
    estimateTokens(msgs.map((m) => m.content).join("")) > max;

// ─── 工具函数 ──────────────────────────────────────────────────

/** 粗略估算字符串的 token 数（英文 ~4 字符/token，中文 ~2 字符/token）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk / 2 + other / 4);
}

// ─── 丢弃策略（独立维度 2：How — drop）────────────────────────

/**
 * 滑动窗口记忆（条数判断 + 丢弃）。
 * 保留最近 N 条非 system 消息，system 消息始终保留。
 * maxMessages 不传则不限制。
 */
export class WindowMemory implements BaseMemory {
  private messages: Message[] = [];

  constructor(private maxMessages?: number) {}

  add(message: Message): void {
    this.messages.push(message);
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  async getMessages(): Promise<Message[]> {
    // 无限制或未超限时，返回全部
    if (
      this.maxMessages === undefined ||
      this.messages.length <= this.maxMessages
    ) {
      return [...this.messages];
    }

    // 保留 system 消息 + 最后 N 条非 system 消息
    const systemMsgs = this.messages.filter((m) => m.role === "system");
    const nonSystem = this.messages.filter((m) => m.role !== "system");
    const recent = nonSystem.slice(-this.maxMessages);
    return [...systemMsgs, ...recent];
  }

  clear(): void {
    this.messages = [];
  }
}

/**
 * 按 token 截断的记忆（token 判断 + 丢弃）。
 * 当非 system 消息的总 token 超过 maxTokens 时，从最旧的非 system 消息开始丢弃。
 */
export class TokenMemory implements BaseMemory {
  private messages: Message[] = [];

  constructor(private maxTokens: number = 4000) {}

  add(message: Message): void {
    this.messages.push(message);
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  async getMessages(): Promise<Message[]> {
    const systemMsgs = this.messages.filter((m) => m.role === "system");
    const nonSystem = this.messages.filter((m) => m.role !== "system");

    // 从最新往回累加，直到超过 maxTokens
    let tokenCount = 0;
    let cutoff = nonSystem.length;
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const msg = nonSystem[i];
      if (!msg) continue;
      const t = estimateTokens(msg.content);
      if (tokenCount + t > this.maxTokens) {
        cutoff = i + 1;
        break;
      }
      tokenCount += t;
    }

    return [...systemMsgs, ...nonSystem.slice(cutoff)];
  }

  clear(): void {
    this.messages = [];
  }
}

// ─── 摘要策略（独立维度 2：How — summarize）──────────────────

export interface SummaryMemoryOptions {
  /** 按消息条数判断超限。默认 20。 */
  maxMessages?: number;
  /** 按 token 估算判断超限。与 maxMessages 同时传时，任一超限即触发。 */
  maxTokens?: number;
  /** 每次摘要压缩多少条消息。默认 15。 */
  summarizeCount?: number;
}

/**
 * 摘要记忆（超限判断 + LLM 摘要）。
 *
 * 超限判断由 maxMessages / maxTokens 决定（内部自动构建 LimitChecker），
 * 与压缩策略隔离。两个条件可单独传或同时传（任一超限即触发）。
 * 超限时把最老的 summarizeCount 条消息用 LLM 压缩成摘要，
 * 摘要后仍超限则从最旧开始截断。
 *
 * 累积摘要：每次摘要把旧摘要也喂给 LLM，生成包含全部历史的渐进式摘要。
 */
export class SummaryMemory implements BaseMemory {
  private messages: Message[] = [];
  private summary: string | null = null;
  private readonly limit: LimitChecker;
  private readonly summarizeCount: number;

  constructor(
    private llm: BaseLLM,
    options?: SummaryMemoryOptions,
  ) {
    const { maxMessages = 20, maxTokens, summarizeCount = 15 } = options ?? {};
    // 构建超限判断：maxMessages 和 maxTokens 任一超限即触发
    const countCheck = byCount(maxMessages);
    const tokenCheck = maxTokens !== undefined ? byToken(maxTokens) : null;
    this.limit = (msgs) => countCheck(msgs) || (tokenCheck?.(msgs) ?? false);
    this.summarizeCount = summarizeCount;
  }

  add(message: Message): void {
    this.messages.push(message);
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  /** 当前摘要内容（如果已生成）。 */
  getSummary(): string | null {
    return this.summary;
  }

  async getMessages(): Promise<Message[]> {
    const systemMsgs = this.messages.filter((m) => m.role === "system");
    const nonSystem = this.messages.filter((m) => m.role !== "system");

    // 未超限：返回 system + 摘要（如有）+ 非系统消息
    if (!this.limit(nonSystem)) {
      const summaryMsg = this.summary
        ? [
            {
              role: "system" as const,
              content: `之前的对话摘要：${this.summary}`,
            },
          ]
        : [];
      return [...systemMsgs, ...summaryMsg, ...nonSystem];
    }

    // 超限：把最老的 summarizeCount 条消息摘要压缩
    const toSummarize = nonSystem.slice(0, this.summarizeCount);
    let recent = nonSystem.slice(this.summarizeCount);

    // 累积摘要：把旧摘要也喂给 LLM，生成包含全部历史的渐进式摘要
    const oldSummary = this.summary
      ? `之前的摘要：${this.summary}\n\n新对话内容：\n`
      : "";
    const dialogueText = toSummarize
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const res = await this.llm.chat({
      messages: [
        {
          role: "system",
          content:
            "请将以下内容压缩成一段简洁的摘要，保留关键信息、决策和上下文。如果已有旧摘要，请将旧摘要与新对话内容合并为一个连贯的摘要。",
        },
        { role: "user", content: oldSummary + dialogueText },
      ],
    });

    this.summary = res.content;
    // 移除已摘要的消息，保留 system 和最近的消息
    this.messages = [...systemMsgs, ...recent];

    // 摘要后仍超限：从最旧开始截断
    while (recent.length > 1 && this.limit(recent)) {
      recent = recent.slice(1);
    }

    const summaryMsg: Message = {
      role: "system",
      content: `之前的对话摘要：${this.summary}`,
    };
    return [summaryMsg, ...recent];
  }

  clear(): void {
    this.messages = [];
    this.summary = null;
  }
}

// ─── 持久化工具 ────────────────────────────────────────────────

import { readFile, writeFile } from "node:fs/promises";

/** 将 memory 中的所有消息保存到 JSON 文件。 */
export async function saveMemory(
  memory: BaseMemory,
  path: string,
): Promise<void> {
  const data = JSON.stringify(memory.getAll(), null, 2);
  await writeFile(path, data, "utf-8");
}

/** 从 JSON 文件加载消息到 memory。 */
export async function loadMemory(
  memory: BaseMemory,
  path: string,
): Promise<void> {
  const data = await readFile(path, "utf-8");
  const messages = JSON.parse(data) as Message[];
  memory.clear();
  for (const msg of messages) {
    memory.add(msg);
  }
}
