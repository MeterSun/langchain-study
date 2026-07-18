import type { Message } from "./type";
import type { LLMResponse } from "./response";

export interface ChatOptions {
  messages: Message[];
}

export interface BaseLLM {
  chat(options: ChatOptions): Promise<LLMResponse>;
  stream(options: ChatOptions): AsyncIterable<string>;
}
