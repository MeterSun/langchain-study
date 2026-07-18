import type { BaseLLM } from "./base";
import type { Message } from "./type";
import type { Tool } from "./tool";

export interface AgentOptions {
  llm: BaseLLM;
  tools?: Tool[];
  systemPrompt?: string;
  maxIterations?: number;
}

export class Agent {
  llm: BaseLLM;
  tools: Tool[];
  systemPrompt?: string;
  maxIterations: number;

  constructor(params: AgentOptions) {
    this.llm = params.llm;
    this.tools = params.tools ?? [];
    this.systemPrompt = params.systemPrompt;
    this.maxIterations = params.maxIterations ?? 10;
  }

  /**
   * 跑 LLM ↔ Tool 循环，直到 LLM 不再发起 tool call，返回最终文本。
   */
  async run(input: string): Promise<string> {
    const messages: Message[] = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push({ role: "user", content: input });

    for (let i = 0; i < this.maxIterations; i++) {
      const res = await this.llm.chat({
        messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
      });

      if (!res.toolCalls || res.toolCalls.length === 0) {
        return res.content;
      }

      messages.push({
        role: "assistant",
        content: res.content,
        toolCalls: res.toolCalls,
      });

      for (const tc of res.toolCalls) {
        const tool = this.tools.find((t) => t.name === tc.name);
        if (!tool) {
          messages.push({
            role: "tool",
            content: `Tool "${tc.name}" not found`,
            toolCallId: tc.id,
          });
          continue;
        }
        try {
          const result = await tool.execute(tc.arguments);
          messages.push({
            role: "tool",
            content: result,
            toolCallId: tc.id,
          });
        } catch (e) {
          messages.push({
            role: "tool",
            content: `Error: ${e instanceof Error ? e.message : String(e)}`,
            toolCallId: tc.id,
          });
        }
      }
    }

    throw new Error(
      `Agent exceeded max iterations (${this.maxIterations}) without final answer`,
    );
  }
}
