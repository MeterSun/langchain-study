import type { z } from "zod";

export interface ToolMetadata {
  /** 功能分类，便于 search 过滤，例如 "math"、"network"、"filesystem"。 */
  category?: string;
  /** 自由标签，便于 search 过滤。 */
  tags?: string[];
  /** 工具版本，便于变更追踪。 */
  version?: string;
  /** 是否需要用户确认（危险操作标记，如删除文件）。 */
  dangerous?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodType;
  metadata?: ToolMetadata;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * 定义工具。execute 收到的是经过 parameters.parse 验证后的参数，
 * 调用方传入的 args 会先被 Zod schema 校验，校验失败抛错由 Agent 当作 tool 错误处理。
 */
export function defineTool<S extends z.ZodObject>(params: {
  name: string;
  description: string;
  parameters: S;
  metadata?: ToolMetadata;
  execute: (args: z.infer<S>) => Promise<string>;
}): Tool {
  return {
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    metadata: params.metadata,
    execute: (args) => params.execute(params.parameters.parse(args)),
  };
}
