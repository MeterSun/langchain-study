import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import {
  HashEmbedder,
  MemoryVectorStore,
  VectorRetriever,
  ingestText,
} from "../src/core/rag.ts";
import { Agent } from "../src/core/agent.ts";
import { createRagTool } from "../src/tools/rag-tool.ts";

const client = new OpenAI({});
const llm = new OpenAIModel(client, "deepseek-v4-flash");
const embedder = new HashEmbedder(256);

// ─── 1. 构建知识库（与 example/9-rag.ts 相同）──────────────────

const knowledgeBase = `
# 产品介绍：Trae Agent Framework

Trae Agent Framework 是一个轻量级的 AI Agent 开发框架，使用 TypeScript 编写。

## 核心模块

### Model Layer
模型层负责统一不同 LLM 的接口。支持 OpenAI、Claude、Gemini 等模型。
所有模型实现 BaseLLM 接口，提供统一的 chat 和 stream 方法。
模型返回统一转换为 LLMResponse 结构，包含 content、toolCalls、usage 等字段。

### Agent Runtime
Agent 运行时实现了 ReAct 循环：LLM 思考 → 工具执行 → LLM 再思考。
支持 maxIterations 限制最大循环次数，防止无限循环。
Agent 维护内部状态（AgentState），包含对话历史和迭代计数。
支持 onStep 回调，外部可以观察每一步的执行情况。

### Tool Framework
工具框架提供 Tool 接口和 defineTool 工厂函数。
工具参数使用 Zod schema 定义，执行时自动校验。
ToolRegistry 负责工具的注册、搜索和调用，支持按 category/tag 过滤。
工具执行支持 timeout 超时保护和 retry 自动重试。
内置工具包括：calculator（计算器）、http_get（HTTP 请求）、read_file（文件读取）、todo_list（任务管理）。

### Prompt Framework
Prompt 框架支持四种模板：PromptTemplate（基础模板）、PromptStore（模板库）、DynamicPrompt（动态选择）、VersionedPrompt（版本管理）。
所有模板实现 PromptLike 接口，提供统一的 render 方法。
Agent 可以在运行时注入 promptVariables 来动态渲染模板。

### Structured Output
结构化输出模块让 LLM 返回符合 Zod schema 的对象。
通过 extractJSON 从 LLM 文本中提取 JSON，支持代码块、混合文本等格式。
校验失败时自动重试，把 Zod 错误信息喂回 LLM 让它修正。

### Memory
记忆模块管理对话历史，支持三种策略：
WindowMemory 按消息条数截断，保留最近的对话。
TokenMemory 按 token 估算截断，更精确地控制 context 用量。
SummaryMemory 使用 LLM 摘要旧对话，保留关键信息。
所有策略实现 BaseMemory 接口，Agent 可自由切换。

### RAG
RAG 模块提供文档检索增强能力。
Chunker 负责文本分块，支持按段落切分和 overlap 重叠。
Embedder 调用 embedding API 将文本转向量。
MemoryVectorStore 使用内存数组存储向量，通过余弦相似度检索。
VectorRetriever 封装了 embed query → 搜索 的完整流程。
Agent 可以通过两种方式使用 RAG：
1. 自动注入：设置 Agent.retriever，每次提问都自动检索并注入 context。
2. Tool 模式：用 createRagTool() 把检索器包装成工具，Agent 自主决定何时调用。
`;

const store = new MemoryVectorStore();
const docCount = await ingestText(knowledgeBase, embedder, store, {
  source: "trae-docs",
  chunkSize: 500,
  overlap: 50,
});
console.log(`知识库已灌入：${docCount} 个文档块\n`);

const retriever = new VectorRetriever(embedder, store);
const ragTool = createRagTool({ retriever, topK: 3 });

// ─── 2. Tool 模式：Agent 自主决定何时检索 ────────────────────

console.log("=== Tool 模式（Agent 自主决定何时调用 rag_search）===\n");

const agent = new Agent({
  llm,
  tools: [ragTool],
  systemPrompt:
    "你是 Trae Agent Framework 的文档助手。涉及内部资料时请调用 rag_search 工具查询，闲聊可以直接回答，不要编造。",
  onStep: (event) => {
    if (event.type === "think") {
      console.log(`  [think] ${event.message.slice(0, 80)}...`);
    } else if (event.type === "tool") {
      console.log(`  [tool] ${event.toolCall?.name}("${(event.toolCall?.arguments as { query?: string })?.query ?? ""}")`);
      console.log(`       → 返回 ${event.toolResult?.length ?? 0} 字符`);
    }
  },
});

// 闲聊：不需要检索
console.log("--- 闲聊（不需要检索）---");
const chat = await agent.run("你好，请做一下自我介绍");
console.log(`回答: ${chat}\n`);

// 文档查询：需要检索
console.log("--- 文档查询（Agent 应该自动调用 rag_search）---");
const docAnswer = await agent.run(
  "Trae Agent Framework 的 RAG 模块有两种使用方式，分别是什么？",
);
console.log(`回答: ${docAnswer}\n`);

// 再问一个关于 Tool Framework 的问题
console.log("--- 再问一个文档问题 ---");
const toolAnswer = await agent.run(
  "ToolRegistry 支持按什么过滤工具？内置工具有哪些？",
);
console.log(`回答: ${toolAnswer}\n`);

// ─── 3. 对比：自动注入模式 vs Tool 模式 ────────────────────────

console.log("=== 对比：自动注入模式 vs Tool 模式 ===\n");

// 自动注入模式（每次提问都检索）
const autoAgent = new Agent({
  llm,
  retriever,
  systemPrompt: "你是 Trae Agent Framework 的文档助手。请基于参考资料回答。",
});

console.log("问题: 今天天气怎么样？（知识库没有，闲聊）\n");

console.log("--- 自动注入模式（每次都检索，浪费调用）---");
const auto = await autoAgent.run("今天天气怎么样？");
console.log(`回答: ${auto}\n`);

// 重置 agent 避免 context 干扰
agent.reset();
console.log("--- Tool 模式（Agent 自己判断不需要检索，直接回答）---");
const tool = await agent.run("今天天气怎么样？");
console.log(`回答: ${tool}\n`);
