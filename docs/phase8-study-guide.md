# Phase 8 Workflow Engine 学习指南

按"先看 demo 跑通 → 再回源码看实现"的节奏，每步配一个示例和检查点。

---

## Step 0：先读总结文档建立全局观

读 [docs/phase8-workflow.md](file:///Users/zhang/github/langchain-study/docs/phase8-workflow.md)

只看前 4 节：**核心问题** / **核心概念表** / **架构设计** / **执行模型**。先建立"图 = 节点 + 边 + 状态"的心智模型，细节先跳过。

**检查点**：能说出 NodeFn 签名、Checkpoint 记录什么、interrupt 干嘛的。

---

## Step 1：StateGraph 基础 —— 节点、边、循环、校验

跑 [example/15-workflow-basic.ts](file:///Users/zhang/github/langchain-study/example/15-workflow-basic.ts)

```bash
npx tsx example/15-workflow-basic.ts
```

关注 3 件事：
1. **图结构**：`START → increment → check → (count<3 ? increment : END)` 是个循环
2. **defaultReducer 数组追加**：`log` 字段每个节点 push 一条，不是覆盖（看最终日志条数）
3. **compile 期校验**：无出边 / 指向不存在节点 / 边冲突 都在编译期抛错

**检查点**：把 `count < 3` 改成 `count < 5`，预期日志条数变化。

---

## Step 2：Checkpoint —— 中断恢复、跨进程持久化

跑 [example/16-workflow-checkpoint.ts](file:///Users/zhang/github/langchain-study/example/16-workflow-checkpoint.ts)

```bash
npx tsx example/16-workflow-checkpoint.ts
```

关注 4 个场景：
1. **场景 1**：`maxIterations=6` 故意中断 → checkpoint 已保存 → 第二次 invoke 从中断处继续（看 `increment 调用次数`增量）
2. **场景 2**：FileSaver 写到 `/tmp/workflow-checkpoints/session-abc.json` → 第二次传 `count: 999` 故意错的初始值，被 checkpoint 覆盖
3. **场景 3**：`resume: false` 强制从头跑
4. **场景 4**：`list()` / `clear(threadId)`

**检查点**：解释为什么场景 2 传 `count: 999` 还能跑出 `count: 5`（答：checkpoint 的 state 覆盖了入参）。

---

## Step 3：Human-in-the-loop —— interrupt + resume

跑 [example/17-workflow-interrupt.ts](file:///Users/zhang/github/langchain-study/example/17-workflow-interrupt.ts)

```bash
npx tsx example/17-workflow-interrupt.ts
```

关注 3 件事：
1. **场景 1**：第一次 invoke 在 `approve` 节点抛 `InterruptError`，catch 后读到 `interruptValue` 和 `state`
2. 第二次 invoke 传 `resumeValue: "approved"` → 节点 fn 内 `interrupt()` 直接返回这个值，不抛错
3. **场景 3**：验证 `prepare` 节点在恢复时**不重复执行**（checkpoint 记录的是"下一个要执行的节点"=approve，prepare 已跑过）

**检查点**：解释为什么 `approve` 节点 fn 会执行两次（答：interrupt 抛错前没完成，恢复时重执行整个 fn，但 `prepare` 在 interrupt 之前已结束，不重跑）。

回源码看 [src/core/workflow.ts#L501-L507](file:///Users/zhang/github/langchain-study/src/core/workflow.ts#L501-L507) 的 `interrupt()` 实现，理解 AsyncLocalStorage 的作用。

---

## Step 4：Streaming —— 事件流消费

跑 [example/18-workflow-stream.ts](file:///Users/zhang/github/langchain-study/example/18-workflow-stream.ts)

```bash
npx tsx example/18-workflow-stream.ts
```

关注 3 个场景：
1. **场景 1**：`for await (const event of app.stream(...))` 完整消费，看事件序列
2. **场景 2**：`break` 中途退出，invoke 在后台继续跑（不报错）
3. **场景 3**：stream + interrupt 组合 —— 第一次 stream 抛 InterruptError，第二次传 resumeValue 继续消费剩余事件

对比 `invoke`（push 模式，onEvent 回调）vs `stream`（pull 模式，for await）的差异。

**检查点**：说出 5 种 WorkflowEvent 类型（node_start / node_end / edge / interrupt / finish）。

回源码看 [src/core/workflow.ts#L337-L384](file:///Users/zhang/github/langchain-study/src/core/workflow.ts#L337-L384) 的 `stream()`，理解 `queue + invokePromise` 桥接。

---

## Step 5：综合 Demo —— 完整业务流程

跑 [example/19-workflow-research.ts](file:///Users/zhang/github/langchain-study/example/19-workflow-research.ts)

```bash
npx tsx example/19-workflow-research.ts
```

这是 Phase 8 的"毕业作品"，把前面所有概念串起来：
- **图结构**：`START → plan → execute → review → (approved ? finalize : plan)` 循环重试
- **interrupt**：review 节点暂停等人工审批
- **Checkpoint**：第 1 轮暂停后保存，第 2/3 轮从 review 恢复
- **条件路由**：`rejected` 回 plan，`approved` 去 finalize
- **事件追踪**：`logEvent` 记录 `▶node → edge → ⏸interrupt → ✓finish`

**检查点**：跟踪事件序列，解释为什么 `rejected` 后回到 `plan` 而不是 `execute`（答：review 的条件边 router 决定，rejected 时 outline 可能有问题，要重新规划）。

---

## Step 6：回源码看核心实现

按这个顺序读 [src/core/workflow.ts](file:///Users/zhang/github/langchain-study/src/core/workflow.ts)：

| 顺序 | 行范围 | 内容 | 看什么 |
|------|--------|------|--------|
| 1 | L14-L52 | 常量 + 类型 + defaultReducer | NodeFn / RouterFn / Reducer 签名 |
| 2 | L85-L156 | StateGraph 构建器 | addNode/addEdge 的校验逻辑 |
| 3 | L186-L321 | CompiledGraph.invoke | while 循环 + checkpoint + interrupt 捕获 |
| 4 | L337-L384 | CompiledGraph.stream | queue 桥接模式 |
| 5 | L388-L478 | Checkpoint 实现 | MemorySaver / FileSaver |
| 6 | L480-L527 | interrupt + InterruptError | AsyncLocalStorage 的妙用 |

最后看 [src/core/workflow-nodes.ts](file:///Users/zhang/github/langchain-study/src/core/workflow-nodes.ts)，理解 `agentNode` / `llmNode` / `routeBy` 三个 helper（共 75 行，很简单）。

---

## 验证学习效果

学完后能答出这 5 个问题就过关：

1. 为什么 NodeFn 返回 `Partial<S>` 而不是 `S`？
2. interrupt 恢复时，节点 fn 内 `interrupt()` 之前的代码会不会再跑？为什么？
3. Checkpoint 记录的是"下一个节点"还是"刚执行完的节点"？为什么这样设计？
4. stream 模式下 `break` 后，invoke 会报错吗？为什么？
5. 什么场景该用 ReAct Agent，什么场景该用 StateGraph？

回答不出来就回去看对应的 Step。

---

## 配套资料

- 总结文档：[docs/phase8-workflow.md](file:///Users/zhang/github/langchain-study/docs/phase8-workflow.md)
- 核心实现：[src/core/workflow.ts](file:///Users/zhang/github/langchain-study/src/core/workflow.ts)
- 节点包装器：[src/core/workflow-nodes.ts](file:///Users/zhang/github/langchain-study/src/core/workflow-nodes.ts)
- 示例：example/15 ~ example/19

## 参考

- LangGraph：StateGraph / Checkpoint / interrupt 的设计原型
- Temporal：Workflow 长流程持久化的工业级实现
- Pregel：图计算模型（StateGraph 的理论源头）
