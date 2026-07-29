import { z } from "zod";
import { readFile } from "node:fs/promises";
import { defineTool } from "../core/tool.ts";

/**
 * 读取本地文件文本内容。截断到 2000 字符防止 context 爆炸。
 */
export const readFileTool = defineTool({
  name: "read_file",
  description: "读取本地文件的文本内容。适合读取代码、配置、文档等文本文件。",
  parameters: z.object({
    path: z.string().describe("文件的绝对路径或相对路径"),
  }),
  metadata: {
    category: "filesystem",
    tags: ["file", "read", "fs"],
    version: "1.0.0",
  },
  execute: async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const truncated = content.length > 2000;
    return truncated ? `${content.slice(0, 2000)}\n...(truncated)` : content;
  },
});
