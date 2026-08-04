import OpenAI from "openai";
import { OpenAIModel } from "../src/core/openai.ts";
import { HashEmbedder } from "../src/core/rag.ts";
import { MemoryVectorStore } from "../src/core/rag.ts";
import { VectorRetriever } from "../src/core/rag.ts";
import { ingestText, chunkText } from "../src/core/rag.ts";
import { Agent } from "../src/core/agent.ts";

const client = new OpenAI({});
const llm = new OpenAIModel(client, "deepseek-v4-flash");
// DeepSeek 不支持 embedding API，用本地 HashEmbedder 演示 RAG 流程
const embedder = new HashEmbedder(256);

// ─── 1. Chunker 验证：文本分块 ─────────────────────────────

console.log("=== 1. Chunker 分块验证 ===\n");

const sampleText = `TypeScript 是由微软开发的开源编程语言，它是 JavaScript 的超集，添加了静态类型系统。

TypeScript 于 2012 年首次发布，由 Anders Hejlsberg 领导开发。它的目标是解决大型 JavaScript 项目中的可维护性和可扩展性问题。

TypeScript 的核心特性包括：类型注解、接口、泛型、装饰器、模块系统。这些特性在编译时会被移除，最终生成纯 JavaScript 代码。

与 JavaScript 不同，TypeScript 在编译阶段就能发现类型错误，而不是等到运行时。这大大减少了调试时间，提高了代码质量。`;

const chunks = chunkText(sampleText, { chunkSize: 100, overlap: 20 });
console.log(`分块结果（${chunks.length} 块）：`);
chunks.forEach((chunk, i) => {
  console.log(`  [${i}] (${chunk.length} 字符) ${chunk.slice(0, 50)}...`);
});

// ─── 2. 端到端 RAG：灌入文档 → 提问 → 验证 ─────────────────

console.log("\n=== 2. 端到端 RAG 验证 ===\n");

// 构造一份"知识库"——模拟公司内部文档
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
Agent 设置 retriever 后，每次提问会自动检索相关文档注入 context。
`;

// 灌入知识库
const store = new MemoryVectorStore();
const docCount = await ingestText(knowledgeBase, embedder, store, {
  source: "trae-docs",
  chunkSize: 500,
  overlap: 50,
});
console.log(`知识库已灌入：${docCount} 个文档块\n`);

// 构造检索器
const retriever = new VectorRetriever(embedder, store);

// 构造带 RAG 的 Agent
const agent = new Agent({
  llm,
  retriever,
  systemPrompt:
    "你是 Trae Agent Framework 的文档助手。请基于提供的参考资料回答问题。",
  onStep: (event) => {
    console.log(
      `  [${event.iteration}] ${event.type} ${event.message.slice(0, 80)}...`
    );
    // if (event.type === "think") {
    //   console.log(`  [think] ${event.message.slice(0, 80)}...`);
    // }
  },
});

// 提问 1：检索 Tool Framework 相关内容
console.log("--- 问题 1: Tool Framework 有哪些内置工具？ ---");
const answer1 = await agent.run("Trae Agent Framework 有哪些内置工具？");
console.log(`回答: ${answer1}\n`);

// 提问 2：检索 Memory 相关内容
console.log("--- 问题 2: Memory 支持哪些策略？ ---");
const answer2 = await agent.run("Memory 模块支持哪几种记忆策略？分别是什么？");
console.log(`回答: ${answer2}\n`);

// 提问 3：检索 RAG 自身（验证循环引用也能检索到）
console.log("--- 问题 3: RAG 模块是怎么工作的？ ---");
const answer3 = await agent.run("RAG 模块的检索流程是怎样的？");
console.log(`回答: ${answer3}\n`);

// ─── 3. 对比验证：无 RAG vs 有 RAG ─────────────────────────

console.log("=== 3. 对比验证：无 RAG vs 有 RAG ===\n");

const agentWithoutRAG = new Agent({
  llm,
  systemPrompt: "你是 Trae Agent Framework 的文档助手。",
});

const question = "Trae Agent Framework 的 ToolRegistry 支持按什么过滤工具？";

console.log(`问题: ${question}\n`);

console.log("--- 无 RAG（LLM 自己猜）---");
const noRAG = await agentWithoutRAG.run(question);
console.log(`回答: ${noRAG}\n`);

console.log("--- 有 RAG（基于文档）---");
const withRAG = await agent.run(question);
console.log(`回答: ${withRAG}\n`);
