import type { BaseLLM } from "./base";
import type { AgentStepEvent, Message, ToolContext } from "./type";
import type { Tool } from "./tool";
import type { InvokeOptions } from "./registry";
import { ToolRegistry } from "./registry";
import type { PromptLike, PromptVariables } from "./prompt";
import type { BaseMemory } from "./memory";
import { WindowMemory } from "./memory";

export interface AgentOptions {
  llm: BaseLLM;
  tools?: Tool[];
  registry?: ToolRegistry;
  systemPrompt?: string | PromptLike;
  maxIterations?: number;
  onStep?: (event: AgentStepEvent) => void;
  /** 工具执行的默认运行时参数（timeout/retry）。 */
  toolInvokeOptions?: InvokeOptions;
  /** 工具共享上下文，工具执行时可读写。 */
  context?: ToolContext;
  /** 对话记忆策略。默认 WindowMemory（无限制）。 */
  memory?: BaseMemory;
}

export interface RunOptions {
  promptVariables?: PromptVariables;
}

export class Agent {
  llm: BaseLLM;
  /** 统一注册中心：tools 数组的工具也会被合并进 registry。 */
  registry: ToolRegistry;
  systemPrompt?: string | PromptLike;
  maxIterations: number;
  onStep?: (event: AgentStepEvent) => void;
  toolInvokeOptions?: InvokeOptions;
  /** 工具共享上下文，工具执行时可读写。 */
  context: ToolContext;
  /** 对话记忆策略。 */
  memory: BaseMemory;

  private iteration = 0;
  private lastStep?: AgentStepEvent;

  constructor(params: AgentOptions) {
    this.llm = params.llm;
    this.registry = params.registry ?? new ToolRegistry();
    if (params.tools?.length) {
      this.registry.registerAll(params.tools);
    }
    this.systemPrompt = params.systemPrompt;
    this.maxIterations = params.maxIterations ?? 10;
    this.onStep = params.onStep;
    this.toolInvokeOptions = params.toolInvokeOptions;
    this.context = params.context ?? {};
    this.memory = params.memory ?? new WindowMemory();
  }

  /** 向后兼容：访问当前所有工具。 */
  get tools(): Tool[] {
    return this.registry.list();
  }

  /** 获取当前 Agent 状态（只读快照）。 */
  getState(): Readonly<{
    messages: Message[];
    iteration: number;
    lastStep?: AgentStepEvent;
  }> {
    return {
      messages: this.memory.getAll(),
      iteration: this.iteration,
      lastStep: this.lastStep,
    };
  }

  /** 清空所有历史消息，重置迭代计数。 */
  reset(): void {
    this.memory.clear();
    this.iteration = 0;
    this.lastStep = undefined;
  }

  /**
   * 跑 LLM ↔ Tool 循环，直到 LLM 不再发起 tool call，返回最终文本。
   * 多次调用会累积对话历史（由 memory 策略决定如何压缩）。
   */
  async run(input: string, options?: RunOptions): Promise<string> {
    // system prompt 仅首轮注入
    const content =
      this.systemPrompt && this.memory.getAll().length === 0
        ? typeof this.systemPrompt === "string"
          ? this.systemPrompt
          : this.systemPrompt.render(options?.promptVariables)
        : undefined;

    if (content) {
      this.memory.add({ role: "system", content });
    }
    this.memory.add({ role: "user", content: input });

    for (this.iteration = 0; this.iteration < this.maxIterations; this.iteration++) {
      // 从 memory 获取（可能已压缩/截断的）消息列表
      const messages = await this.memory.getMessages();
      const res = await this.llm.chat({
        messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
      });

      // Think step
      this.emit({
        type: "think",
        iteration: this.iteration,
        message: res.content || "(no content)",
      });

      if (!res.toolCalls || res.toolCalls.length === 0) {
        this.memory.add({ role: "assistant", content: res.content });
        this.emit({
          type: "finish",
          iteration: this.iteration,
          message: res.content,
        });
        return res.content;
      }

      this.memory.add({
        role: "assistant",
        content: res.content,
        toolCalls: res.toolCalls,
      });

      // Execute each tool call via registry (带 timeout/retry 保护)
      for (const tc of res.toolCalls) {
        const tool = this.registry.get(tc.name);
        if (!tool) {
          const msg = `Tool "${tc.name}" not found`;
          this.memory.add({ role: "tool", content: msg, toolCallId: tc.id });
          this.emit({
            type: "error",
            iteration: this.iteration,
            message: msg,
            toolCall: tc,
          });
          continue;
        }
        try {
          const result = await this.registry.invokeTool(
            tool,
            tc.arguments,
            this.toolInvokeOptions,
            this.context,
          );
          this.memory.add({ role: "tool", content: result, toolCallId: tc.id });
          this.emit({
            type: "tool",
            iteration: this.iteration,
            message: `Tool "${tc.name}" executed`,
            toolCall: tc,
            toolResult: result,
          });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.memory.add({
            role: "tool",
            content: `Error: ${errMsg}`,
            toolCallId: tc.id,
          });
          this.emit({
            type: "error",
            iteration: this.iteration,
            message: `Tool "${tc.name}" error: ${errMsg}`,
            toolCall: tc,
          });
        }
      }
    }

    throw new Error(
      `Agent exceeded max iterations (${this.maxIterations}) without final answer`,
    );
  }

  private emit(event: AgentStepEvent): void {
    this.lastStep = event;
    this.onStep?.(event);
  }
}
