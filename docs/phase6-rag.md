# Phase 6 RAG 学习收获

## 核心问题

如何让 Agent 基于外部知识（文档、手册、内部资料）回答问题，而不是只靠 LLM 训练时学到的权重。即"给 LLM 外接一个可检索的记忆"。

## 核心概念

| 概念 | 含义 | 在本实现中的对应 |
|------|------|-----------------|
| **RAG** (Retrieval-Augmented Generation) | 检索增强生成。先从外部知识库检索相关文档，再拼到 LLM 上下文里生成回答 | 整个 Phase 6 |
| **Chunk / Document** | 文档块。把长文本切成可被检索的小单元 | `Document` 接口（content + embedding + metadata） |
| **Embedding** | 把文本映射成定长向量，让"语义相近"等价于"向量相近" | `BaseEmbedder.embed(text) → number[]` |
| **Vector Space / Dim** | 向量空间维度。维度越高表达能力越强、冲突越少 | `OpenAIEmbedder` 1536 维，`HashEmbedder` 默认 256 维 |
| **Cosine Similarity** | 余弦相似度。衡量两个向量方向是否一致，范围 [-1, 1]，越接近 1 越相似 | `cosineSimilarity(a, b)` |
| **L2 Normalization** | 把向量长度归一为 1。归一化后余弦相似度 = 点积，且长短文档可比 | `HashEmbedder.embed` 末尾 |
| **Top-K Retrieval** | 只返回相似度最高的 K 个文档块，避免 context 爆炸 | `store.search(query, topK)` |
| **Overlap** | 相邻块之间的字符重叠，避免在语义边界处切断信息 | `chunkText({ overlap: 50 })` |
| **Sparse vs Dense Vector** | 稀疏向量（大部分维度为 0，如 hash trick）vs 稠密向量（每维都有值，如神经网络 embedding） | `HashEmbedder` 稀疏，`OpenAIEmbedder` 稠密 |
| **Ingest** | 灌库：原始文本 → 分块 → 向量化 → 存入 VectorStore | `ingestText()` |
| **Retrieve** | 检索：query → 向量化 → 余弦搜索 → 返回 Top-K 文档 | `Retriever.retrieve()` |

## 架构设计

### 组件管道

RAG 流程拆成 4 个独立组件，串成一条管道：

```
灌库阶段（离线，一次）：
  原始文本
     │
     ▼
  Chunker（分块）─────► Embedder（向量化）─────► VectorStore（存储）

查询阶段（在线，每次 run）：
  用户 query
     │
     ▼
  Retriever
     ├── embed(query)         ← 复用 Embedder
     └── store.search(vec, K) ← 复用 VectorStore
     │
     ▼
  Top-K 文档 → 注入 Agent context
```

### 接口与实现分离

每个组件都是"接口 + 至少一个实现"，可单独替换：

| 组件 | 接口 | 内置实现 | 可替换为 |
|------|------|---------|---------|
| Chunker | `chunkText(text, options)` 函数 | 按段落切 + 超长硬切，带 overlap | 递归切分 / 按 token 切 / Markdown 按标题切 |
| Embedder | `BaseEmbedder` | `OpenAIEmbedder` / `HashEmbedder` | 智谱 / 阿里 / 本地 BGE / Ollama |
| VectorStore | `VectorStore` | `MemoryVectorStore` | Chroma / Qdrant / pgvector |
| Retriever | `Retriever` | `VectorRetriever` | 多路召回 / 混合检索（向量 + BM25） |

一站式工具函数 `ingestText(text, embedder, store, options)` 把分块 → 向量化 → 存储 串起来，调用方不用手动 orchestrate 三步。

### Agent 集成（两种互斥模式）

```
模式 A — 自动注入（new Agent({ retriever })）
  Agent.run 内部：
    docs = await retriever.retrieve(input)
    把 docs 拼成 system message 注入 memory
  特点：每次都检索，无脑增强，适合纯问答机器人

模式 B — Tool 调用（new Agent({ tools: [createRagTool({ retriever })] })）
  Agent 把 rag_search 注册为工具
  LLM 按 ReAct 循环自主决定何时调用
  特点：闲聊不浪费检索，适合泛用 Agent
```

## 核心设计逻辑

### 1. 为什么要分块？整篇文档直接向量化不行吗？

- **检索精度**：整篇文档的向量是"全文语义的平均"，会稀释局部相关信号。查询"Memory 模块"时，整篇产品文档的向量里 Memory 只占 1/10，相似度被其他模块稀释；分块后只有 Memory 块的向量高度相关。
- **context 经济**：LLM context window 有限，Top-K 文档块（几百~几千字）比整篇文档（几万字）省得多。
- **可定位**：检索结果带 `metadata.chunk` 索引，能告诉用户"答案出自第几块"。

### 2. 为什么 chunk 之间要 overlap？

避免在语义边界处切断信息：

```
没有 overlap：
  块 N:    "...Memory 模块管理对话历史，支持三种策略："
  块 N+1:  "WindowMemory 按消息条数截断..."

  → 查询"Memory 有哪些策略"时，块 N 有标题没内容，块 N+1 有内容没标题，都不完整

有 overlap（50 字符）：
  块 N:    "...Memory 模块管理对话历史，支持三种策略：WindowMemory 按消息条数..."
  块 N+1:  "支持三种策略：WindowMemory 按消息条数截断..."

  → 块 N 既保留了标题，也带出了第一个策略名，检索命中后 LLM 能直接看到上下文
```

### 3. 为什么要 L2 归一化 + 余弦相似度，而不是直接点积或欧氏距离？

- **点积受向量长度影响**：长文档 token 多，向量模长大，点积虚高 → 检索偏向长文档而非相关文档。
- **欧氏距离偏向短文档**：与点积相反，没考虑方向。
- **余弦相似度只看方向**：归一化后 `[1,0,0]` 和 `[2,0,0]` 视为相同（都是 x 轴方向），让长短文档在同一个尺度下比较。
- **L2 归一化后余弦相似度 = 点积**：计算更快（一次点积搞定，不用每次算 norm）。

### 4. 为什么 Embedder / VectorStore / Retriever 要分开抽象？

理论上可以合成一个 `vectorDB.search(text, K)`，但拆开有三个好处：

- **Embedder 可独立替换**：换 embedding 模型时（OpenAI → 本地 BGE），不动 VectorStore
- **VectorStore 可独立替换**：从内存数组升级到 Chroma 时，不动 Embedder
- **Retriever 封装"embed + search"两步为一个语义**：调用方不用关心"先向量化再搜索"的实现细节，只调用 `retrieve(query, K)`

这是经典的"组合优于继承" —— Retriever 通过依赖注入持有 Embedder 和 VectorStore，而非自己实现它们。

### 5. 为什么需要两种 Agent 集成模式？

两种模式对应两种 Agent 定位：

- **自动注入**：Agent 的核心职责就是"基于知识库回答"（QA 机器人、文档助手）。检索是必须的，不需要 LLM 决策。
- **Tool 调用**：Agent 是泛用的（既能闲聊也能查文档）。检索是可选的，让 LLM 根据场景判断。

自动注入看起来"更智能"（每次都增强），其实把决策权从 LLM 拿走了。Tool 模式让 LLM 自主决策，反而更经济 —— 这也符合 ReAct 的精神。

### 6. 为什么 HashEmbedder 走稀疏 + hash trick？

真实 embedding API 需要：网络请求 + API Key + 计费 + 模型可用性。任一环节断了，整个 RAG 模块就跑不起来。

`HashEmbedder` 用 hash trick 生成稀疏向量：
- **零依赖**：纯 TypeScript，无网络无 API
- **可重现**：同一段文本永远生成同一向量，方便调试
- **跑通流程**：让 Chunker / VectorStore / Retriever / Agent 集成都能独立验证，不阻塞开发

代价是精度差（无语义理解 + hash 冲突），但作为 fallback 足够。生产场景换回真实 Embedder 即可，接口不变。

## 三个关键收获

### 1. 两种集成模式：自动注入 vs Tool 调用

这是 RAG 集成到 Agent 的核心设计选择，二者各擅胜场：

```
模式 A — 自动注入（Agent.retriever）
  每次 run(input) 都先 retrieve(input) → 把文档塞进 system message
  特点：无脑检索，适合纯问答机器人

模式 B — Tool 模式（createRagTool）
  把 Retriever 包装成 Tool 注册到 Agent
  LLM 自主决定是否调用 rag_search
  特点：闲聊不浪费检索，适合泛用 Agent
```

**关键差异**（实测对比）：

| 场景 | 自动注入 | Tool 模式 |
|------|---------|----------|
| 问"今天天气"（知识库无） | 仍检索一次，浪费 | LLM 直接回答，0 次检索 |
| 问"ToolRegistry 怎么用" | 自动注入相关文档 | LLM 调用 `rag_search(query)` |
| 实现复杂度 | Agent 内 ~10 行 | 多一个 `createRagTool` 工厂 |

**教训**：自动注入看起来"更智能"（每次都增强），其实是把决策权从 LLM 拿走了。Tool 模式让 LLM 自己判断需要时再检索，反而更经济。这也符合 ReAct 的精神——让 LLM 自主决策。

### 2. Embedder 要有 fallback：真实 API 不一定可用

原计划用 OpenAI embedding，但 .env 配的是 DeepSeek，DeepSeek 根本不提供 embedding 接口（404）。

**解决方案**：实现 `HashEmbedder` 作为零依赖 fallback。

```
HashEmbedder 原理：
  1. tokenize：英文按单词、中文按字符 bigram 切分
  2. hash：每个 token 哈希到 [0, dim) 的桶
  3. 累加：桶值 += 1（词袋模型）
  4. L2 归一化（让余弦相似度有意义）
```

**教训**：演示项目也要有零依赖 fallback。如果强依赖外部 API，网络/账户/模型不支持任何一个环节断了，整个模块就跑不起来。`HashEmbedder` 精度差但能跑通流程，让 RAG 的其他部分（Chunker、VectorStore、Retriever、Agent 集成）都能独立验证。

### 3. 检索失败诊断：HashEmbedder 的两个本质缺陷

实测发现查询"Memory 模块支持哪几种记忆策略"时，Memory 文档块（chunk=8）在 Top-3 中排第 4，被 Structured Output 文档块（chunk=7）挤掉。

**精确重叠对比**（理想情况下重叠越多应该越相关）：

| 文档块 | 与查询精确重叠的 token | 实际相似度 | 排名 |
|--------|---------------------|-----------|------|
| chunk=7 Structured Output | `模块`, `支持`（2 个） | 0.3198 | #1 ✅ |
| chunk=8 Memory | `memory`, `记忆`, `模块`, `支持`, `策略`（5 个） | 0.1971 | #4 ❌ |

真正相关的文档块反而输了 —— 因为两个缺陷叠加：

**缺陷 1：Hash 冲突造成"虚假命中"**

256 维空间太小，无关 token 会碰撞到同一桶：

```
查询 token "memory" → 桶 255 | chunk=7 中 "output" 也在桶 255  ← 虚假命中
查询 token "策略"   → 桶 207 | chunk=7 中 "zod" 也在桶 207      ← 虚假命中
查询 token "几种"   → 桶 237 | chunk=7 中 "llm" 也在桶 237      ← 虚假命中
查询 token "什么"   → 桶 136 | chunk=7 中 "对象" 也在桶 136      ← 虚假命中
```

`memory` 和 `output` 风马牛不相及，却因 hash 碰撞造成相似度虚高。

**缺陷 2：L2 归一化稀释真实命中**

- chunk=8（Memory）77 个 token，5 个真实命中被 77 维 norm 稀释
- chunk=7（Structured）64 个 token，虚假命中集中在少数桶且部分重复（`llm`、`zod`），权重更集中

结果：虚假命中 > 真实命中，反相关排序。

**根本原因**：HashEmbedder 是稀疏字面匹配（bag-of-tokens + hash trick），既无语义理解（"Memory" ≠ "记忆" 在它眼里是两个独立 token），又受 hash 冲突影响。维度越低冲突越严重。

**教训**：调试检索质量问题时，不能只看 Top-K 结果，要打印所有候选的相似度排名 + 精确 token 重叠 + hash 桶分布，才能定位是"召回失败"还是"排序失败"。本次是排序失败 —— 目标文档块在候选集里，但被挤出了 Top-K。

## 最终设计

```
src/core/rag.ts
  ├── 类型：Document, BaseEmbedder, VectorStore, Retriever
  ├── Chunker：chunkText(text, { chunkSize, overlap })
  ├── Embedder
  │   ├── OpenAIEmbedder（真实 API，1536 维）
  │   └── HashEmbedder（本地 fallback，可配维度）
  ├── VectorStore
  │   └── MemoryVectorStore（数组 + cosine）
  ├── Retriever
  │   └── VectorRetriever（embed query → search）
  └── 工具：ingestText() 一站式灌库

src/tools/rag-tool.ts
  └── createRagTool({ retriever, topK, maxCharsPerDoc })
      把 Retriever 包装成 Tool，交给 Agent 自主调用

Agent 集成（互斥二选一）
  ├── 模式 A：new Agent({ retriever })      → 自动注入
  └── 模式 B：new Agent({ tools: [ragTool] }) → Tool 调用
```

## 遗留问题

1. **HashEmbedder 精度不足**：演示用足够，但生产场景必须替换为真实 embedding API（OpenAI / 智谱 / 阿里 / 本地 BGE 等）。增大维度（256 → 2048）能缓解冲突，但无法解决"无语义理解"的根本问题。

2. **retriever 和 rag-tool 模式未在 Agent 层强制互斥**：同时设置会既自动注入又触发 Tool 调用，造成重复检索。可在 `Agent` 构造函数加运行时校验。

3. **chunkSize/overlap 凭经验**：当前 500/50 是直觉值，没做调参。生产场景应根据文档类型（代码 / 散文 / 表格）和 embedding 模型特性调整。

4. **VectorStore 无持久化**：进程结束即丢失。生产场景需实现 `FileVectorStore` 或对接外部向量数据库（Chroma、Qdrant、pgvector）。
