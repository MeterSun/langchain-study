import OpenAI from "openai";
import type { BaseLLM, ChatOptions } from "./base";
import type { LLMResponse } from "./response";
import type { Message } from "./type";

// Message 是项目内的最小协议，这里适配到 OpenAI SDK 的 discriminated union。
// SDK 的 tool role 还要求 tool_call_id，目前 Message 暂未携带，先做类型桥接。
const toOpenAIMessages = (
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] =>
  messages as unknown as OpenAI.ChatCompletionMessageParam[];

export class OpenAIModel implements BaseLLM {
  constructor(
    private client: OpenAI,
    private model: string = "gpt-5",
  ) {}

  async chat(options: ChatOptions): Promise<LLMResponse> {
    const result = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(options.messages),
    });

    const choice = result.choices[0];
    return {
      content: choice?.message.content ?? "",
      usage: {
        promptTokens: result.usage?.prompt_tokens ?? 0,
        completionTokens: result.usage?.completion_tokens ?? 0,
        totalTokens: result.usage?.total_tokens ?? 0,
      },
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
