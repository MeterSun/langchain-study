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
