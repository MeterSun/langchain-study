import { z } from "zod";
import { defineTool } from "../core/tool.ts";

/**
 * 计算器工具：支持基本四则运算表达式。
 * 用 Function 求值，仅允许数字和运算符（已做字符白名单校验）。
 */
export const calculator = defineTool({
  name: "calculator",
  description: "计算数学表达式，支持加减乘除、括号、小数。例如：1+2*3、(1+2)/3",
  parameters: z.object({
    expression: z.string().describe("数学表达式，例如 1+2*3"),
  }),
  metadata: {
    category: "math",
    tags: ["arithmetic", "calculate"],
    version: "1.0.0",
  },
  execute: async ({ expression }) => {
    // 白名单：只允许数字、运算符、括号、小数点、空格
    if (!/^[\d+\-*/().\s]+$/.test(expression)) {
      throw new Error(
        `Invalid expression: only numbers and + - * / ( ) are allowed`,
      );
    }
    const result = Function(`"use strict"; return (${expression})`)();
    if (typeof result !== "number" || !isFinite(result)) {
      throw new Error(`Expression did not produce a finite number: ${expression}`);
    }
    return String(result);
  },
});
