我建议直接把整个项目定位成 **「使用 TypeScript 从零实现一个 Agent Framework」**，而不是“学习如何使用 LangGraph”。这样最后得到的是一个类似 **LiteLLM + LangGraph + OpenAI Agents SDK** 的轻量版框架。

另外，我建议技术栈统一一下：

- **Runtime**：Node.js 22+
- **Language**：TypeScript 5.x
- **Package Manager**：pnpm
- **Framework**：前期不依赖框架，后期可接入 Next.js/Fastify
- **Schema**：Zod（代替 Pydantic）
- **Validation**：Zod
- **Storage**：PostgreSQL + pgvector、Redis
- **Browser**：Playwright
- **Embedding**：OpenAI / VoyageAI / Jina 等
- **ORM**：Drizzle ORM 或 Prisma
- **Workflow**：前期自己实现，后面对比 LangGraph

---

# Phase 0：LLM Abstraction Layer

> 目标：实现一个统一的模型接口，让 Agent 完全不关心底层是 GPT、Claude、Gemini 还是本地模型。

---

## 为什么要做

如果直接这样写：

```ts
const client = new OpenAI();

const res = await client.chat.completions.create({
  model: "gpt-5",
  messages,
});
```

整个项目都会和 OpenAI SDK 强绑定。

以后换 Claude：

```ts
const client = new Anthropic(...)
```

所有代码都要改。

所以第一步就是抽象 Model Layer。

---

# 技术点

学习：

- Chat Completion
- Streaming
- Structured Output
- Tool Calling
- Message Protocol
- Token Usage
- Model Adapter Pattern

---

# 实现思路

整个架构：

```text
Agent

     │

LLM Interface

     │

──────────────────────────

OpenAI Adapter

Claude Adapter

Gemini Adapter

Ollama Adapter

```

Agent 永远调用：

```ts
llm.chat(...)
```

而不是：

```ts
openai.chat(...)
```

---

# 推荐目录

```text
packages/

    core/

        llm/

            base.ts
            message.ts
            response.ts

            openai.ts
            claude.ts
            gemini.ts

        agent/

        tools/

apps/

    playground/

```

以后直接发展成 Monorepo。

---

# Message 定义

```ts
export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;

  content: string;
}
```

以后 Claude、Gemini 全部转换成这个结构。

---

# Response

```ts
export interface LLMUsage {
  promptTokens: number;

  completionTokens: number;

  totalTokens: number;
}

export interface ToolCall {
  id: string;

  name: string;

  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;

  toolCalls?: ToolCall[];

  usage?: LLMUsage;

  finishReason?: string;
}
```

以后无论什么模型：

全部转换成：

```ts
LLMResponse;
```

---

# Base LLM

```ts
export interface ChatOptions {
  messages: Message[];
}

export interface BaseLLM {
  chat(options: ChatOptions): Promise<LLMResponse>;
}
```

以后所有模型：

```ts
class OpenAIModel

implements BaseLLM
```

---

# OpenAI Adapter

例如：

```ts
export class OpenAIModel implements BaseLLM {
  constructor(private client: OpenAI) {}

  async chat(options: ChatOptions): Promise<LLMResponse> {
    const result = await this.client.chat.completions.create({
      model: "gpt-5",

      messages: options.messages,
    });

    return {
      content: result.choices[0].message.content ?? "",

      usage: {
        promptTokens: result.usage?.prompt_tokens ?? 0,

        completionTokens: result.usage?.completion_tokens ?? 0,

        totalTokens: result.usage?.total_tokens ?? 0,
      },
    };
  }
}
```

---

# Claude Adapter

Adapter 做的事情就是：

```text
Claude Response

↓

Parse

↓

LLMResponse
```

Agent 永远不知道 Claude 长什么样。

---

# Structured Output

TypeScript 推荐：

```ts
import { z } from "zod";

export const UserSchema = z.object({
  name: z.string(),

  age: z.number(),
});
```

解析：

```ts
const user = UserSchema.parse(json);
```

以后所有输出：

不要：

```ts
const obj = JSON.parse(text);
```

而是：

```ts
schema.parse();
```

---

# Streaming

统一接口：

```ts
export interface BaseLLM {
  stream(options: ChatOptions): AsyncIterable<string>;
}
```

以后：

```ts
for await (
    const token of llm.stream(...)
) {

    process.stdout.write(token);

}
```

OpenAI SSE

↓

Claude Stream

↓

Gemini Stream

全部隐藏。

---

# Todo

### 基础

- [ ] Message 类型
- [ ] Response 类型
- [ ] BaseLLM Interface

---

### Adapter

- [ ] OpenAI
- [ ] Claude
- [ ] Gemini
- [ ] Ollama

---

### Streaming

- [ ] AsyncIterable
- [ ] AbortController
- [ ] Retry

---

### Structured Output

- [ ] Zod Schema
- [ ] JSON Parse
- [ ] Validation
- [ ] Retry

---

### Usage

- [ ] Token Usage
- [ ] Cost
- [ ] Latency

---

### 测试

最终应该做到：

```ts
const agent = new Agent({
  llm: new OpenAIModel(),
});
```

切换：

```ts
const agent = new Agent({
  llm: new ClaudeModel(),
});
```

Agent 一行代码不用改。

---

# 推荐参考项目（按学习价值排序）

| 项目                           | 学习重点                                        |
| ------------------------------ | ----------------------------------------------- |
| OpenAI Agents SDK (TypeScript) | Agent、Tool、Runner、Trace 的整体设计           |
| Vercel AI SDK                  | Provider 抽象、Streaming、UI 集成               |
| LiteLLM                        | 多模型统一接口（虽然是 Python，但设计值得学习） |
| LangChain.js                   | ChatModel、Runnable、Tool 抽象                  |
| Mastra                         | TypeScript Agent Framework 的整体架构           |
| AI SDK Core                    | Model、Prompt、Stream 的抽象方式                |

---

## 我建议再升级一步：整个教程不是"实现一个 Agent"，而是**实现一个 mini Agent Framework**。

也就是每一阶段都遵循：

```text
设计（Why）
    ↓
接口（Interface）
    ↓
数据结构（Types）
    ↓
核心实现（Implementation）
    ↓
单元测试（Vitest）
    ↓
Demo（Playground）
    ↓
对标开源框架（LangChain / Vercel AI SDK / OpenAI Agents SDK）
```

这样到最后，你得到的不只是一个能运行的 Agent，而是一套具有可扩展性的 TypeScript Agent Framework。
