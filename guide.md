我建议把目标再明确一点：

> **目标不是学习 Agent，而是从零实现一个 TypeScript Agent Framework。**

整个学习路线围绕一句话展开：

> **每完成一个 Phase，就完成 Agent Framework 的一个核心模块。**

最终实现的框架能力对标：

- **Model Layer**：LiteLLM / Vercel AI SDK
- **Agent Layer**：OpenAI Agents SDK
- **Workflow**：LangGraph
- **Memory**：MemGPT / Letta
- **RAG**：LlamaIndex
- **Multi-Agent**：AutoGen / CrewAI

---

# 最终目录

建议整个项目采用 Monorepo：

```text
agent-framework/

├── apps/
│   ├── playground/          # Demo
│   ├── web-chat/            # Next.js Chat
│   └── docs/                # 文档
│
├── packages/
│
│   ├── core/                # Agent Core
│
│   ├── llm/                 # Model Provider
│
│   ├── prompt/
│
│   ├── tools/
│
│   ├── memory/
│
│   ├── rag/
│
│   ├── workflow/
│
│   ├── browser/
│
│   ├── code/
│
│   ├── multi-agent/
│
│   ├── evaluation/
│
│   └── common/
│
└── examples/
```

整个学习路线，就是不断填满这些 package。

---

# Phase 0：Model Layer（LLM Abstraction）

## 学习目标

实现一个统一的模型接口，让 Agent 不依赖任何模型 SDK。

**最终能力**

```ts
const agent = new Agent({
  llm: new OpenAIModel(),
});

// ↓

// 一行不改

const agent = new Agent({
  llm: new ClaudeModel(),
});
```

---

## 技术点

### Message Protocol

学习：

- Chat Message
- Role
- System Prompt
- Tool Message

实现：

```
Message

↓

Model Adapter

↓

Provider Message
```

---

### Response

统一：

```
LLMResponse

↓

content

toolCalls

usage

finishReason
```

---

### Streaming

学习：

- SSE
- AsyncIterator
- AbortController

---

### Structured Output

学习：

- Zod
- JSON Schema
- Retry

---

### Tool Calling

统一：

```
OpenAI

↓

ToolCall

↓

Claude

↓

ToolCall

↓

Gemini

↓

ToolCall
```

---

## Todo

### Message

- [ ] Message Type
- [ ] Role
- [ ] Conversation History

---

### Response

- [ ] Usage
- [ ] FinishReason
- [ ] ToolCall

---

### Provider

- [ ] OpenAI
- [ ] Claude
- [ ] Gemini
- [ ] Ollama

---

### Streaming

- [ ] stream()
- [ ] cancel()
- [ ] timeout()

---

### Validation

- [ ] Zod
- [ ] JSON Parse
- [ ] Retry

---

## Demo

实现：

```
playground/

↓

输入

↓

OpenAI

↓

Claude

↓

Gemini

↓

统一输出
```

---

## 推荐资料

### 学习源码

★★★★★

Vercel AI SDK

★★★★★

OpenAI Agents SDK

★★★★☆

LiteLLM

★★★★☆

LangChain ChatModel

---

# Phase 1：Agent Runtime（ReAct）

## 学习目标

实现 Agent Loop。

最终：

```
Question

↓

Think

↓

Tool

↓

Observe

↓

Think

↓

Finish
```

---

## 技术点

学习：

ReAct

Agent State

Iteration

Context

---

## Todo

- [ ] Agent
- [ ] Loop
- [ ] Max Iteration
- [ ] State
- [ ] History

---

## Demo

```
北京天气

↓

Agent

↓

Tool

↓

Answer
```

---

## 推荐资料

ReAct Paper

OpenAI Agents SDK Runner

---

# Phase 2：Tool Framework

目标：

实现 Tool Framework。

---

## 技术点

学习：

Tool Registry

Function Calling

Permission

MCP 思想

---

## Todo

### Tool

- [ ] BaseTool

- [ ] Schema

- [ ] Metadata

---

### Registry

- [ ] register()

- [ ] search()

- [ ] invoke()

---

### 内置 Tool

- [ ] Calculator

- [ ] Search

- [ ] File

- [ ] HTTP

- [ ] SQL

---

### Tool Runtime

- [ ] Timeout

- [ ] Retry

- [ ] Error

---

## Demo

Agent：

```
查询今天北京天气
```

↓

自动调用：

Weather Tool

---

## 推荐资料

MCP

OpenAI Function Calling

---

# Phase 3：Prompt Framework

目标：

实现 Prompt 管理。

---

学习：

Prompt Template

Prompt Version

Few-shot

Dynamic Prompt

---

Todo

- [ ] Prompt Template

- [ ] Variables

- [ ] Render

- [ ] Prompt Store

---

Demo：

```
{{name}}

↓

Tom
```

---

参考：

LangChain Prompt

---

# Phase 4：Structured Output

目标：

所有输出变对象。

学习：

Zod

JSON Schema

Retry

---

Todo

- [ ] Object Parser

- [ ] Validator

- [ ] Auto Retry

- [ ] Error Fix

---

Demo

```
LLM

↓

JSON

↓

Object
```

---

# Phase 5：Memory

学习：

Conversation

Semantic Memory

Summary

Retrieval

---

Todo

Short Memory

- [ ] History

- [ ] Window

Long Memory

- [ ] Save

- [ ] Search

- [ ] Summary

---

参考：

MemGPT

Letta

---

# Phase 6：RAG

目标：

Agent 有知识。

学习：

Chunk

Embedding

Retriever

Hybrid Search

Rerank

---

Todo

Loader

- [ ] PDF

- [ ] Markdown

- [ ] Web

Embedding

- [ ] Chunk

- [ ] Vector

Search

- [ ] Similarity

- [ ] Hybrid

- [ ] Rerank

---

Demo

上传 PDF

↓

Agent 回答

---

参考：

LlamaIndex

LangChain

---

# Phase 7：Planning

目标：

复杂任务拆解。

学习：

CoT

ToT

Plan & Execute

Task Graph

---

Todo

- [ ] Planner

- [ ] Task Queue

- [ ] Dependency

- [ ] Retry

---

Demo

```
开发博客

↓

Task1

Task2

Task3
```

---

参考：

BabyAGI

AutoGPT

---

# Phase 8：Workflow Engine

目标：

实现 mini LangGraph。

学习：

State Machine

Node

Edge

Checkpoint

Resume

---

Todo

- [ ] Node

- [ ] Edge

- [ ] Graph

- [ ] State

- [ ] Checkpoint

---

Demo

```
START

↓

PLAN

↓

EXECUTE

↓

CHECK

↓

END
```

---

参考：

LangGraph

Temporal

---

# Phase 9：Browser Agent

学习：

Playwright

DOM

Vision

Action

---

Todo

- [ ] Open Page

- [ ] Click

- [ ] Input

- [ ] Screenshot

- [ ] OCR

---

参考：

Browser Use

Claude Computer Use

---

# Phase 10：Coding Agent

目标：

实现 mini Cursor。

学习：

Repo

AST

Tree-sitter

Git

---

Todo

- [ ] Read Repo

- [ ] Search Symbol

- [ ] Modify File

- [ ] Run Test

- [ ] Fix Error

---

参考：

Cursor

SWE-Agent

OpenHands

---

# Phase 11：Multi-Agent

学习：

Manager

Worker

Reviewer

Communication

---

Todo

- [ ] Message Bus

- [ ] Shared Memory

- [ ] Agent Router

- [ ] Agent Pool

---

Demo

```
Manager

↓

Research

↓

Coder

↓

Reviewer
```

---

参考：

AutoGen

CrewAI

MetaGPT

---

# Phase 12：Evaluation & Security

学习：

Tracing

Metrics

Permission

Sandbox

Prompt Injection

---

Todo

Evaluation

- [ ] Trace

- [ ] Cost

- [ ] Token

- [ ] Success Rate

Security

- [ ] Tool Permission

- [ ] Sandbox

- [ ] Secret Manager

- [ ] Prompt Injection Filter

---

参考：

LangSmith

Arize Phoenix

OpenTelemetry

---

# 最终项目（Agent Framework v1）

最终实现的能力：

| 模块              | 对标项目                       |
| ----------------- | ------------------------------ |
| Model Layer       | Vercel AI SDK / LiteLLM        |
| Prompt            | LangChain Prompt               |
| Tool Framework    | OpenAI Agents SDK              |
| Agent Runtime     | OpenAI Agents SDK Runner       |
| Structured Output | OpenAI Structured Output + Zod |
| Memory            | MemGPT / Letta                 |
| RAG               | LlamaIndex                     |
| Planning          | AutoGPT / BabyAGI              |
| Workflow          | LangGraph                      |
| Browser           | Browser Use                    |
| Coding Agent      | Cursor / OpenHands             |
| Multi-Agent       | AutoGen / CrewAI               |
| Evaluation        | LangSmith                      |
| Security          | MCP + Sandbox + Permission     |

---

## 每个 Phase 建议固定交付物

为了保证不是“学完就忘”，建议每个阶段都完成以下内容：

- 🎯 **学习目标（Why）**：为什么需要这个模块，它解决什么问题。
- 📚 **核心概念（What）**：涉及的理论、协议、数据结构和设计模式。
- 🏗️ **架构设计（Architecture）**：模块关系图、时序图、状态流。
- 🔧 **接口设计（Interface）**：TypeScript 类型、抽象类、公共 API。
- 💻 **核心实现（Implementation）**：一步步实现关键逻辑。
- ✅ **Todo Checklist**：可勾选的开发任务。
- 🧪 **单元测试（Vitest）**：覆盖核心功能和边界情况。
- 🚀 **Demo（Playground）**：一个可运行的示例程序。
- 📖 **源码阅读（Reference）**：对应优秀开源项目的相关模块。
- 📝 **阶段总结（Review）**：学到了什么、还有哪些可优化点。

这样的路线完成后，你得到的不仅是一个可运行的 Agent，而是一套具备**框架设计、工程实践、可扩展架构**能力的 TypeScript Agent Framework。
