import type { BaseLLM } from "./base";
import type { AgentState, AgentStepEvent, ToolCall } from "./type";
import type { Tool } from "./tool";
import type { PromptLike, PromptVariables } from "./prompt";

export interface AgentOptions {
  llm: BaseLLM;
  tools?: Tool[];
  systemPrompt?: string | PromptLike;
  maxIterations?: number;
  onStep?: (event: AgentStepEvent) => void;
}

export interface RunOptions {
  promptVariables?: PromptVariables;
}

export class Agent {
  llm: BaseLLM;
  tools: Tool[];
  systemPrompt?: string | PromptLike;
  maxIterations: number;
  onStep?: (event: AgentStepEvent) => void;

  private state: AgentState;

  constructor(params: AgentOptions) {
    this.llm = params.llm;
    this.tools = params.tools ?? [];
    this.systemPrompt = params.systemPrompt;
    this.maxIterations = params.maxIterations ?? 10;
    this.onStep = params.onStep;
    this.state = { messages: [], iteration: 0 };
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

      // Execute each tool call
      for (const tc of res.toolCalls) {
        const tool = this.tools.find((t) => t.name === tc.name);
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
          const result = await tool.execute(tc.arguments);
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
