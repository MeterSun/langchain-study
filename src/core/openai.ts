import OpenAI from "openai";
import { z } from "zod";
import type { BaseLLM, ChatOptions } from "./base";
import type { LLMResponse } from "./response";
import type { Message, ToolCall } from "./type";
import type { Tool } from "./tool";

// Message 是项目内的最小协议，这里把它适配到 OpenAI SDK 的 discriminated union。
// 注意：ToolCall.arguments 是对象，但 OpenAI SDK 的 tool_calls.function.arguments 是 JSON 字符串。
const toOpenAIMessages = (
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] =>
  messages.map((m): OpenAI.ChatCompletionMessageParam => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls && {
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        }),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
      };
    }
    if (m.role === "system") {
      return { role: "system", content: m.content };
    }
    return { role: "user", content: m.content };
  });

const toOpenAITools = (tools: Tool[]): OpenAI.ChatCompletionTool[] =>
  tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.parameters) as Record<string, unknown>,
    },
  }));

export class OpenAIModel implements BaseLLM {
  constructor(
    private client: OpenAI,
    private model: string = "gpt-5",
  ) {}

  async chat(options: ChatOptions): Promise<LLMResponse> {
    const result = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(options.messages),
      ...(options.tools?.length
        ? { tools: toOpenAITools(options.tools) }
        : {}),
    });

    const choice = result.choices[0];
    const message = choice?.message;
    const functionCalls = message?.tool_calls?.filter(
      (tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall =>
        tc.type === "function",
    );
    const toolCalls: ToolCall[] | undefined = functionCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      content: message?.content ?? "",
      ...(toolCalls && { toolCalls }),
      usage: {
        promptTokens: result.usage?.prompt_tokens ?? 0,
        completionTokens: result.usage?.completion_tokens ?? 0,
        totalTokens: result.usage?.total_tokens ?? 0,
      },
      finishReason: choice?.finish_reason,
    };
  }

  async *stream(options: ChatOptions): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(options.messages),
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) yield token;
    }
  }
}
