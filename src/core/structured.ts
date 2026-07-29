import { z } from "zod";
import type { BaseLLM } from "./base";
import type { Message } from "./type";

// ─── 类型 ──────────────────────────────────────────────────────

export interface StructuredOptions<S extends z.ZodType> {
  llm: BaseLLM;
  messages: Message[];
  schema: S;
  /** 最大重试次数（不含首次）。默认 2。 */
  retries?: number;
  /** 透传给 LLM 的格式指令。 */
  formatInstruction?: string;
}

export interface StructuredResult<S extends z.ZodType> {
  data: z.infer<S>;
  /** 总尝试次数（含首次，1 表示一次成功）。 */
  attempts: number;
  /** 最后一次 LLM 的原始文本响应。 */
  rawResponse: string;
}

export interface StructuredChatOptions {
  /** 可选 system prompt。 */
  systemPrompt?: string;
  /** 最大重试次数（不含首次）。默认 2。 */
  retries?: number;
  /** 透传给 LLM 的格式指令。 */
  formatInstruction?: string;
}

// ─── 工具函数 ──────────────────────────────────────────────────

const DEFAULT_FORMAT_INSTRUCTION = `请以 JSON 格式回复，不要包含 markdown 代码块标记（不要用 \`\`\`json），直接输出纯 JSON。`;

/** 从 Zod schema 生成 JSON Schema 文本，帮 LLM 理解需要输出哪些字段。 */
export function describeSchema(schema: z.ZodType): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema), null, 2);
  } catch {
    return "";
  }
}

/**
 * 从 LLM 文本响应中提取 JSON。
 * 依次尝试：纯 JSON → ```json 代码块 → 第一个 {...} → 第一个 [...]
 */
export function extractJSON(text: string): unknown {
  const trimmed = text.trim();

  // 纯 JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续
  }

  // ```json ... ``` 代码块
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock?.[1]) {
    try {
      return JSON.parse(codeBlock[1].trim());
    } catch {
      // 继续
    }
  }

  // 第一个 { ... }
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      // 继续
    }
  }

  // 第一个 [ ... ]
  const arrMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch {
      // 继续
    }
  }

  throw new Error(`无法从 LLM 响应中提取 JSON: ${text.slice(0, 200)}`);
}

// ─── 核心函数 ──────────────────────────────────────────────────

/**
 * 调用 LLM 获取结构化输出。
 * 流程：LLM → 提取 JSON → schema.parse 校验 → 失败则把错误喂回 LLM 重试。
 */
export async function generateStructured<S extends z.ZodType>(
  options: StructuredOptions<S>,
): Promise<StructuredResult<S>> {
  const {
    llm,
    messages,
    schema,
    retries = 2,
    formatInstruction = DEFAULT_FORMAT_INSTRUCTION,
  } = options;

  // 把 Zod schema 转成 JSON Schema 文本拼进 format instruction，
  // 让 LLM 明确知道需要输出哪些字段及类型约束
  const schemaDesc = describeSchema(schema);
  const fullInstruction = schemaDesc
    ? `${formatInstruction}\n\n需要输出的 JSON 结构：\n${schemaDesc}`
    : formatInstruction;

  const conversation: Message[] = [
    ...messages,
    { role: "system", content: fullInstruction },
  ];

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await llm.chat({ messages: conversation });

    try {
      // 提取 JSON → Zod 校验 → 返回类型安全的对象
      const json = extractJSON(res.content);
      const data = schema.parse(json);
      return { data, attempts: attempt + 1, rawResponse: res.content };
    } catch (e) {
      lastError = e;
      // 校验失败时，把 LLM 的错误输出和校验错误都加入对话，
      // 让 LLM 在下一轮看到自己的错误并修正
      if (attempt < retries) {
        const errorMsg = e instanceof Error ? e.message : JSON.stringify(e);
        conversation.push({ role: "assistant", content: res.content });
        conversation.push({
          role: "user",
          content: `上一次输出解析失败，错误：${errorMsg}\n请修正后重新输出符合要求的 JSON。`,
        });
      }
    }
  }

  throw new Error(
    `结构化输出在 ${retries + 1} 次尝试后仍失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * 简化的结构化输出调用。
 * 直接传 LLM + 输入文本 + schema，返回解析后的对象（不含 attempts 等元信息）。
 * 内部调用 generateStructured，适合不需要精细控制 messages 的场景。
 */
export async function structuredChat<S extends z.ZodType>(
  llm: BaseLLM,
  input: string,
  schema: S,
  options?: StructuredChatOptions,
): Promise<z.infer<S>> {
  const messages: Message[] = [];
  if (options?.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: input });

  const result = await generateStructured({
    llm,
    messages,
    schema,
    retries: options?.retries,
    formatInstruction: options?.formatInstruction,
  });
  return result.data;
}
