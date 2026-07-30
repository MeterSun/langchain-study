# Phase 5 Memory 学习收获

## 核心问题

如何管理 Agent 的对话历史，让 LLM 在长对话中不丢关键信息、不撑爆 context window。

## 三个关键收获

### 1. 存储和视图要分离

`getAll()` 存了多少条 ≠ `getMessages()` 发给 LLM 多少条。

Memory 的核心职责不是"存"，而是"决定给 LLM 看什么"。这个分离让调试（看全部）和运行（看压缩后）各取所需。

```
getAll()      → 返回全部存储的消息（调试/持久化用）
getMessages() → 返回压缩/截断后的消息（发给 LLM 用）
```

**踩坑**：一开始测试 WindowMemory 时，用 `getState().messages`（等于 `getAll()`）检查"是否记得苹果"，显示 true。但 LLM 实际看不到苹果——因为 `getMessages()` 已经把它截断了。

### 2. 摘要必须累积

单级摘要 = 丢历史。

第一次摘要了北京+上海，第二次摘要广州+成都时，如果旧摘要不参与，北京+上海就彻底丢失。

```
错误做法：每次摘要只处理当前批次的老消息
正确做法：旧摘要 + 新对话 一起喂给 LLM，生成渐进式合并摘要

第1轮: [北京, 上海] → summary1
第2轮: summary1 + [广州, 成都] → summary2（包含全部4城）
第3轮: summary2 + [西安, 重庆] → summary3（包含全部6城）
```

另外：摘要生成后必须存回 `this.summary`，未超限时 `getMessages()` 也要返回摘要。否则下次调用时摘要不见了。

### 3. 判断和决策是两个正交维度

"何时压缩"（按条数/按 token）和"如何压缩"（丢弃/摘要）应该独立。

```
维度 1 — 判断（When）     维度 2 — 决策（How）
  byCount(20)               drop（丢弃旧的）
  byToken(4000)             summarize（LLM 摘要）
```

**演进过程**：

1. 最初：`SummaryMemory(llm, maxMessages, summarizeThreshold)` — 条数判断 + 摘要，耦合
2. 加 token 支持：`SummaryMemory(llm, maxMessages, summarizeThreshold, maxTokens?)` — 补丁，maxTokens 覆盖 maxMessages，二选一
3. 拆分：`SummaryMemory(llm, limit: LimitChecker, count)` — 判断逻辑外部注入，完全解耦
4. 最终：`SummaryMemory(llm, { maxMessages?, maxTokens?, summarizeCount? })` — 内部隔离 + 外部简单参数，两个条件可同时传（OR 关系）

**教训**：内部隔离 ≠ API 复杂。用 options 对象传数字，内部自动构建 LimitChecker，用户无感。

## 最终设计

```
BaseMemory 接口
  ├── WindowMemory      = byCount + drop（固定组合，足够简单不拆）
  ├── TokenMemory       = byToken + drop（固定组合）
  └── SummaryMemory     = byCount/byToken + summarize（判断可插拔）

LimitChecker（判断函数）
  ├── byCount(max)
  └── byToken(max)

持久化工具
  ├── saveMemory(memory, path)
  └── loadMemory(memory, path)
```

## 遗留问题

摘要后仍超限（极端场景：maxTokens 很小或单条消息极长）时，当前方案是直接截断。更好的做法是循环摘要一轮再截断兜底，但未实现。
