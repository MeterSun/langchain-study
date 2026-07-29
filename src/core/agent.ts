import type { BaseLLM } from "./base";
import type { AgentState, AgentStepEvent } from "./type";
import type { Tool } from "./tool";
import type { InvokeOptions } from "./registry";
import { ToolRegistry } from "./registry";
import type { PromptLike, PromptVariables } from "./prompt";

export interface AgentOptions {
  llm: BaseLLM;
  tools?: Tool[];
  registry?: ToolRegistry;
  systemPrompt?: string | PromptLike;
  maxIterations?: number;
  onStep?: (event: AgentStepEvent) => void;
  /** 工具执行的默认运行时参数（timeout/retry）。 */
  toolInvokeOptions?: InvokeOptions;
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

  private state: AgentState;

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
    this.state = { messages: [], iteration: 0 };
  }

  /** 向后兼容：访问当前所有工具。 */
  get tools(): Tool[] {
    return this.registry.list();
  }

  /** 获取当前 Agent 状态（只读快照）。 */
  getState(): Readonly<AgentState> {
    return this.state;
  }

  /** 清空所有历史消息，重置迭代计数。 */
  reset(): void {
    this.state = { messages: [], iteration: 0 };
  }

  /**
   * 跑 LLM ↔ Tool 循环，直到 LLM 不再发起 tool call，返回最终文本。
   * 多次调用会累积对话历史。
   */
  async run(input: string, options?: RunOptions): Promise<string> {
    const content =
      this.systemPrompt && this.state.messages.length === 0
        ? typeof this.systemPrompt === "string"
          ? this.systemPrompt
          : this.systemPrompt.render(options?.promptVariables)
        : undefined;

    if (content) {
      this.state.messages.push({ role: "system", content });
    }
    this.state.messages.push({ role: "user", content: input });

    for (
      this.state.iteration = 0;
      this.state.iteration < this.maxIterations;
      this.state.iteration++
    ) {
      const res = await this.llm.chat({
        messages: this.state.messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
      });

      // Think step
      this.emit({
        type: "think",
        iteration: this.state.iteration,
        message: res.content || "(no content)",
      });

      if (!res.toolCalls || res.toolCalls.length === 0) {
        this.state.messages.push({
          role: "assistant",
          content: res.content,
        });
        this.emit({
          type: "finish",
          iteration: this.state.iteration,
          message: res.content,
        });
        return res.content;
      }

      this.state.messages.push({
        role: "assistant",
        content: res.content,
        toolCalls: res.toolCalls,
      });

      // Execute each tool call via registry (带 timeout/retry 保护)
      for (const tc of res.toolCalls) {
        const tool = this.registry.get(tc.name);
        if (!tool) {
          const msg = `Tool "${tc.name}" not found`;
          this.state.messages.push({
            role: "tool",
            content: msg,
            toolCallId: tc.id,
          });
          this.emit({
            type: "error",
            iteration: this.state.iteration,
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
          );
          this.state.messages.push({
            role: "tool",
            content: result,
            toolCallId: tc.id,
          });
          this.emit({
            type: "tool",
            iteration: this.state.iteration,
            message: `Tool "${tc.name}" executed`,
            toolCall: tc,
            toolResult: result,
          });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          this.state.messages.push({
            role: "tool",
            content: `Error: ${errMsg}`,
            toolCallId: tc.id,
          });
          this.emit({
            type: "error",
            iteration: this.state.iteration,
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
    this.state.lastStep = event;
    this.onStep?.(event);
  }
}
