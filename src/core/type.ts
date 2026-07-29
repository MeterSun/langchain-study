export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export type StepType = "think" | "tool" | "finish" | "error";

export interface AgentStepEvent {
  type: StepType;
  iteration: number;
  message: string;
  toolCall?: ToolCall;
  toolResult?: string;
}

export interface AgentState {
  messages: Message[];
  iteration: number;
  lastStep?: AgentStepEvent;
}

/**
 * 工具执行上下文。由 Agent 持有，执行工具时传入。
 * 工具可自由读写其中的字段来共享/持久化状态。
 */
export interface ToolContext {
  [key: string]: unknown;
}
