import type { ToolCall } from "./type";

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: LLMUsage;
  finishReason?: string;
}
