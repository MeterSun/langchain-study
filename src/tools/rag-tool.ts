import { z } from "zod";
import type { Retriever, Document } from "../core/rag";
import { defineTool, type Tool } from "../core/tool";

export interface RagToolOptions {
  /** 检索器。 */
  retriever: Retriever;
  /** 工具名，默认 rag_search。 */
  name?: string;
  /** 工具描述。 */
  description?: string;
  /** 返回 top-K，默认 3。 */
  topK?: number;
  /** 每个文档块最大输出字符数（防止 context 爆炸），默认 800。 */
  maxCharsPerDoc?: number;
}

/** 把一个文档格式化为 LLM 易读的字符串。 */
function formatDoc(doc: Document, maxChars: number): string {
  let content = doc.content;
  let truncated = false;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars);
    truncated = true;
  }
  const source = doc.metadata?.source ?? "unknown";
  const chunk = doc.metadata?.chunk;
  const header = `[来源: ${source}${typeof chunk === "number" ? ` / 第${chunk}块` : ""}]`;
  return `${header}\n${content}${truncated ? "\n...(已截断)" : ""}`;
}

/**
 * 工厂：把 Retriever 包装成一个 Tool，让 Agent 自主决定何时检索。
 *
 * 与 Agent 自动注入 retriever 的区别：
 * - 自动注入：每次用户提问都检索，适合问答机器人
 * - Tool 模式：Agent 自主判断是否需要检索，适合泛用 Agent（闲聊时不浪费检索调用）
 */
export function createRagTool(options: RagToolOptions): Tool {
  const {
    retriever,
    name = "rag_search",
    description = "检索内部知识库里的相关文档。当用户提问涉及内部资料、文档、产品信息等你不确定的内容时调用。",
    topK = 3,
    maxCharsPerDoc = 800,
  } = options;

  return defineTool({
    name,
    description,
    parameters: z.object({
      query: z.string().describe("要检索的关键词或问题描述"),
    }),
    // 用 category="rag" 标记，让 Agent 能识别 rag-tool 并与 retriever 做互斥校验
    metadata: { category: "rag" },
    execute: async ({ query }) => {
      const docs = await retriever.retrieve(query as string, topK);
      if (docs.length === 0) {
        return "知识库中未找到相关文档。";
      }
      return docs.map((d) => formatDoc(d, maxCharsPerDoc)).join("\n\n---\n\n");
    },
  });
}
