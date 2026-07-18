import type { z } from "zod";

export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * 定义工具。execute 收到的是经过 parameters.parse 验证后的参数，
 * 调用方传入的 args 会先被 Zod schema 校验，校验失败抛错由 Agent 当作 tool 错误处理。
 */
export function defineTool<S extends z.ZodObject>(
  params: {
    name: string;
    description: string;
    parameters: S;
    execute: (args: z.infer<S>) => Promise<string>;
  },
): Tool {
  return {
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: (args) => params.execute(params.parameters.parse(args)),
  };
}
