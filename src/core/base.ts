import type { Message } from "./type";
import type { LLMResponse } from "./response";
import type { Tool } from "./tool";

export interface ChatOptions {
  messages: Message[];
  tools?: Tool[];
}

export interface BaseLLM {
  chat(options: ChatOptions): Promise<LLMResponse>;
  stream(options: ChatOptions): AsyncIterable<string>;
}
