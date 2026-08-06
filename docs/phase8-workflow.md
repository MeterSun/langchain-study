# Phase 8 Workflow Engine 学习收获

## 核心问题

Agent 的 ReAct 循环（think → act → observe）本质是**单条线性流程**，无法表达：

- **分支**：根据中间结果走不同路径（如审批通过/拒绝走不同节点）
- **循环**：失败后回到规划节点重试
- **人工干预**：跑到某一步暂停，等人决策后继续
- **断点恢复**：长流程崩溃后从上次位置继续，而非从头跑
- **多组件协作**：Agent / LLM / Tool / 人工 混合编排，需要统一的状态流

Workflow Engine 把"流程"从 Agent 内部抽出来，变成可声明、可观测、可中断、可恢复的图。对标 LangGraph。

## 核心概念

| 概念 | 含义 | 在本实现中的对应 |
|------|------|-----------------|
| **StateGraph** | 状态图构建器（不可变 API） | `StateGraph<S>` |
| **Node** | 执行步骤：接收 state，返回 patch | `NodeFn<S> = (state) => Partial<S>` |
| **Edge** | 步骤间转移（普通边） | `addEdge(from, to)` |
| **ConditionalEdge** | 条件边：下一节点由 router(state) 决定 | `addConditionalEdge(from, router)` |
| **State** | 在节点间流动的数据（用户自定义泛型 S） | `S` |
| **Reducer** | 把 patch 合并到 current state | `StateReducer<S>` / `defaultReducer` |
| **START / END** | 虚拟入口/出口节点（不执行 fn） | `START` / `END` 常量 |
| **CompiledGraph** | 编译后的可执行图 | `CompiledGraph<S>.invoke / stream` |
| **Checkpoint** | 执行快照：state + currentNode + iteration | `Checkpoint<S>` |
| **CheckpointSaver** | 快照持久化器（Memory/File） | `BaseCheckpointSaver<S>` |
| **interrupt** | 节点 fn 内调用，暂停等人工输入 | `interrupt(value)` |
| **InterruptError** | interrupt 抛出的错误，承载 state/node | `InterruptError<S>` |
| **resumeValue** | 恢复时人工传入的决策值 | `InvokeOptions.resumeValue` |
| **Streaming** | 事件流 AsyncGenerator 输出 | `CompiledGraph.stream` |
| **WorkflowEvent** | 事件类型：node_start/end、edge、interrupt、finish | `WorkflowEvent<S>` |
| **节点包装器** | 把 Agent/LLM 包成 NodeFn 的 helper | `agentNode` / `llmNode` / `routeBy` |

## 架构设计

```
构建期（声明式）             执行期（命令式）
─────────────              ──────────────
StateGraph<S>              CompiledGraph<S>
  .addNode(name, fn)         .invoke(state, opts) → state
  .addEdge(from, to)         .stream(state, opts) → AsyncGenerator<event>
  .addConditionalEdge(...)   
  .compile(opts) ────────→  while (current !== END):
                                exec node.fn(state) → patch
                                reducer(state, patch) → state
                                nextNode(current, state) → next
                                save checkpoint
```

### 执行模型（Pregel 简化版）

```
START → node1 → node2 → (条件路由) → node3 → ... → END

每步：
  1. onEvent(node_start)
  2. patch = await node.fn(state)      ← 可能 interrupt()
  3. state = reducer(state, patch)     ← 数组字段追加，标量覆盖
  4. onEvent(node_end)
  5. next = nextNode(current, state)   ← 条件边优先，其次普通边
  6. onEvent(edge)
  7. checkpoint.save({ state, currentNode: next, ... })
```

### 组件关系

```
src/core/workflow.ts
  ├── 构建器：StateGraph<S>          （addNode/addEdge/compile）
  ├── 执行器：CompiledGraph<S>       （invoke/stream/nextNode）
  ├── Reducer：defaultReducer        （浅合并 + 数组追加）
  ├── Checkpoint
  │   ├── 接口：BaseCheckpointSaver
  │   ├── MemorySaver               （进程内 Map）
  │   └── FileSaver                 （每 thread 一个 JSON 文件）
  ├── Human-in-the-loop
  │   ├── interrupt(value)           （节点 fn 内调用）
  │   ├── InterruptError             （承载中断上下文）
  │   └── resumeStorage              （AsyncLocalStorage 传 resumeValue）
  └── Streaming
      └── stream(state)              （queue + invokePromise 桥接）

src/core/workflow-nodes.ts
  ├── agentNode(agent, inKey, outKey)  （Agent → NodeFn）
  ├── llmNode(llm, prompt, outKey)     （LLM → NodeFn）
  └── routeBy(field, mapping)          （字段值 → 节点名）
```

## 核心设计逻辑

### 1. 为什么 Node 是 `(state) => patch` 而非 `(state) => state`？

```ts
type NodeFn<S> = (state: S) => Promise<Partial<S>> | Partial<S>;
```

- **patch + reducer**：节点只声明"我改了哪些字段"，合并逻辑由 reducer 统一处理
- **可预测**：节点不能意外覆盖它不关心的字段
- **可扩展**：换 reducer 即可改变合并语义（如字段级冲突解决、IM-style 累积）

如果节点直接返回完整 state，每个节点都要重复"保留其他字段"的逻辑，且容易写错（漏字段）。

### 2. 为什么 defaultReducer 对数组字段做追加？

```ts
if (Array.isArray(v) && Array.isArray(cur)) {
  result[k] = [...cur, ...v];   // 追加
} else {
  result[k] = v;                 // 覆盖
}
```

工作流里大量字段是"累积型"的：`log`、`messages`、`history`、`steps`。如果用覆盖，每个节点都要写 `state.log.concat([newEntry])`，冗余且易错。

标量字段（如 `status`、`attempt`）则用覆盖，符合直觉。

**取舍**：用户可传自定义 reducer 覆盖此行为（如字段级合并策略）。

### 3. 为什么 interrupt 用 AsyncLocalStorage 而非返回特殊值？

```ts
export function interrupt<T = unknown>(value?: unknown): T {
  const resumeValue = resumeStorage.getStore();
  if (resumeValue !== undefined) return resumeValue as T;
  throw new InterruptError(value);
}
```

**方案对比**：

| 方案 | 问题 |
|------|------|
| 节点 fn 返回特殊标记 | 签名被污染，所有节点都要处理"是否中断"分支 |
| throw 异常 | 节点 fn 内部 try/catch 会吞掉，行为不可控 |
| **AsyncLocalStorage** | 节点 fn 签名不变；深度嵌套的工具调用也能触发 interrupt；恢复时透明返回值 |

AsyncLocalStorage 让 `interrupt()` 像同步函数一样工作：
- 首次执行：抛 InterruptError，被 invoke 捕获
- 恢复执行：从 `resumeStorage` 读 resumeValue 直接返回

节点作者完全不用感知"我在恢复中"，只写 `const decision = interrupt(...)` 即可。

### 4. 为什么 interrupt 恢复时**重执行整个节点 fn**？

```ts
// invoke 内：
e.node = current;
// checkpoint 保存：currentNode = current（不是 next）
// 恢复时：从 current 重新进 while 循环
```

**为什么不保存"interrupt 之前的局部状态"再续跑？**

- 节点 fn 是黑盒，JS 无法序列化闭包内的局部变量
- 即使能保存，恢复时栈帧已销毁，无法续跑

**重执行的代价**：interrupt() 之前的代码会再跑一次。要求节点 fn **幂等**：
- 不要在 interrupt 前做不可逆操作（如发邮件、扣款）
- 有副作用的操作放到 interrupt 之后

这是 LangGraph 的同款约束，工程上可接受 —— interrupt 通常放在节点开头或纯计算之后。

### 5. 为什么 stream 用 `queue + invokePromise` 桥接？

```ts
async *stream(state, options) {
  const queue: WorkflowEvent<S>[] = [];
  const onEvent = (e) => { queue.push(e); resolveWait(); };
  const invokePromise = this.invoke(state, { ...options, onEvent }).catch(...);
  
  while (true) {
    if (queue.length === 0) {
      if (invokeError !== null) throw invokeError;
      await waitForEvent();
    }
    while (queue.length > 0) {
      const event = queue.shift()!;
      yield event;
      if (event.type === "finish") { await invokePromise; return event.state; }
    }
  }
}
```

**问题**：invoke 是 push 模式（onEvent 回调），stream 是 pull 模式（for await）。

**桥接**：
- invoke 在后台跑，事件 push 到 queue
- stream generator 从 queue pull，queue 空就 await waitForEvent
- 调用方 `break` 时 invoke 仍在后台，用 `finally { invokePromise.catch(() => {}) }` 吞掉未处理 rejection

**为什么不直接把 invoke 写成 async iterator？**

invoke 有自己的错误处理、checkpoint、interrupt 逻辑，重写一份 iterator 版本会重复大量代码。桥接模式让两个 API 共享核心实现，只在外层适配消费模式。

### 6. 为什么 Checkpoint 记录"下一个要执行的节点"而非"刚执行完的节点"？

```ts
// 节点执行完后保存：
await saver.save({
  state,
  currentNode: next,    // ← 下一个要执行的
  iteration,
  ...
});
```

恢复时直接 `current = cp.currentNode` 进入 while 循环，无需判断"上次跑完了吗"。

**对比**：如果记录"刚执行完的节点"，恢复时还要查边表找 next，且要处理"刚执行完的节点是否要重跑"的歧义。

**interrupt 时的特殊处理**：interrupt 在节点 fn 内抛出，此时 fn 未完成，checkpoint 记录 `currentNode = current`（当前节点），iteration 减 1，让恢复时重跑当前节点。

### 7. 为什么 maxIterations 默认 25？

- 太小（如 5）：合法循环（如多次重试）会被误杀
- 太大（如 1000）：死循环要烧很久才报错
- 25：覆盖典型工作流（10 节点 × 2-3 轮循环），死循环时也能快速暴露

调用方可在 `compile({ maxIterations })` 或 `invoke({ maxIterations })` 覆盖。

## 三个关键收获

### 1. StateGraph vs ReAct：流程编排 vs 自主决策

| 维度 | ReAct Agent | StateGraph Workflow |
|------|------------|---------------------|
| 决策者 | LLM 每步决定下一步 | 编译期固定图 + 运行期条件路由 |
| 可预测性 | 同输入可能走不同路径 | 图结构固定，执行可追溯 |
| 循环 | LLM 自己决定是否再调用工具 | 显式 `addConditionalEdge` 回环 |
| 人工干预 | 难（LLM 不知道何时该停） | `interrupt()` 原生支持 |
| 断点恢复 | 难（状态在 memory 里，无结构） | Checkpoint 自动保存 |
| 适用场景 | 工具调用为主、路径灵活 | 流程固定、需要可控可观测 |

**教训**：ReAct 适合"查天气"这种 LLM 自主决策的场景；StateGraph 适合"研究→草稿→审批→定稿"这种流程已知的场景。两者互补，不是替代。LangGraph 实践中常把 Agent 作为 StateGraph 的一个节点（见 `agentNode` helper）。

### 2. Checkpoint + interrupt 让长流程可中断恢复

实测（example/19-workflow-research.ts）：

```
[第 1 轮] plan → execute → review ⏸interrupt
  ↓ 保存 checkpoint: currentNode=review, state.draft="..."
[人工] rejected
  ↓ resumeValue: "rejected"
[第 2 轮] review (重执行) → (router: rejected) → plan → execute → review ⏸interrupt
[人工] approved
  ↓ resumeValue: "approved"
[第 3 轮] review (重执行) → (router: approved) → finalize → END ✓
```

关键点：
- **interrupt 抛错时 checkpoint 已保存**，进程崩了也能从 review 恢复
- **resumeValue 通过 AsyncLocalStorage 透传**，节点 fn 透明获取人工决策
- **router 根据 state.approval 决定回 plan 还是去 finalize**，循环自然表达

**教训**：长流程（人工审批、多轮迭代）必须可中断。把状态序列化到 checkpoint，比依赖进程内存可靠得多。FileSaver 还能跨进程恢复。

### 3. Streaming 让流程可见可控

```ts
for await (const event of app.stream(initialState)) {
  if (event.type === "node_start") console.log("▶", event.node);
  if (event.type === "edge") console.log(`  ${event.from} → ${event.to}`);
  if (event.type === "interrupt") {
    console.log("⏸ 等待人工输入");
    break;  // 中途退出，invoke 在后台继续
  }
  if (event.type === "finish") {
    console.log("✓", event.state);
    break;
  }
}
```

事件类型覆盖全生命周期：`node_start` / `node_end` / `edge` / `interrupt` / `finish`。

**教训**：长流程必须有可观测性。onEvent 回调适合"事件驱动"消费（如推 WebSocket），stream generator 适合"顺序消费"（如 CLI 打印）。两者底层共享同一份事件源，按场景选 API。

## 关键文件

- 实现：[src/core/workflow.ts](file:///Users/zhang/github/langchain-study/src/core/workflow.ts)
- 节点包装器：[src/core/workflow-nodes.ts](file:///Users/zhang/github/langchain-study/src/core/workflow-nodes.ts)
- 基础 Demo：[example/15-workflow-basic.ts](file:///Users/zhang/github/langchain-study/example/15-workflow-basic.ts)
- Checkpoint Demo：[example/16-workflow-checkpoint.ts](file:///Users/zhang/github/langchain-study/example/16-workflow-checkpoint.ts)
- Interrupt Demo：[example/17-workflow-interrupt.ts](file:///Users/zhang/github/langchain-study/example/17-workflow-interrupt.ts)
- Stream Demo：[example/18-workflow-stream.ts](file:///Users/zhang/github/langchain-study/example/18-workflow-stream.ts)
- 综合 Demo：[example/19-workflow-research.ts](file:///Users/zhang/github/langchain-study/example/19-workflow-research.ts)

## 可优化点

1. **Subgraph 嵌套**：当前用"节点 fn 内调子图 invoke"实现，没有专门 API。可加 `addSubgraphNode(name, subgraph, inputMapper, outputMapper)` 简化。
2. **并行节点**：当前图是线性的（一个节点一个节点跑），无 `addParallelEdge`。LangGraph 支持 fan-out/fan-in，需要扩展执行模型。
3. **Checkpoint 版本化**：当前每 thread 只存最新一份，无法回溯历史。可加 `listVersions(threadId)` 和 `load(threadId, version)`。
4. **可视化**：导出 Mermaid / DOT 图，方便调试和文档化。
5. **节点超时**：当前节点 fn 无超时保护，卡死的 LLM 调用会阻塞整个图。可在 invoke 层加 `nodeTimeout`。

## 参考

- LangGraph：StateGraph / Checkpoint / interrupt 的设计原型
- Temporal：Workflow 长流程持久化的工业级实现
- Pregel：图计算模型（StateGraph 的理论源头）
