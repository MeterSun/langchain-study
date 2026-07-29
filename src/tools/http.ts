import { z } from "zod";
import { defineTool } from "../core/tool.ts";

/**
 * HTTP GET 工具：抓取指定 URL 的文本内容。
 * 超时由 ToolRegistry 的 timeoutMs 控制。
 */
export const httpGet = defineTool({
  name: "http_get",
  description: "发送 HTTP GET 请求，返回响应文本。适合获取网页或 API 数据。",
  parameters: z.object({
    url: z.string().url().describe("要请求的完整 URL"),
  }),
  metadata: {
    category: "network",
    tags: ["http", "fetch", "request"],
    version: "1.0.0",
  },
  execute: async ({ url }) => {
    const res = await fetch(url, {
      headers: {},
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const text = await res.text();
    // 防止超大响应拖垮 context，截断到 2000 字符
    const truncated = text.length > 2000;
    return truncated ? `${text.slice(0, 2000)}\n...(truncated)` : text;
  },
});
