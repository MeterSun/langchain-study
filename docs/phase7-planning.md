# Phase 7 Planning 学习收获

## 核心问题

如何让 Agent 处理**复杂任务**（如"开发博客"、"研究 X 并对比 Y"）？

ReAct 单步循环（think → act → observe）缺乏全局视图，复杂任务下容易跑偏、绕路、无限循环。Planning 是"先想清楚再动手"：把目标拆成有顺序/有依赖的子任务，再执行。

## 核心概念

| 概念 | 含义 | 在本实现中的对应 |
|------|------|-----------------|
| **Plan & Execute** | 两阶段：先规划完整 plan，再逐个执行 | `PlanExecuteAgent` |
| **Task** | 子任务单元，含 id / description / status / result | `Task` 接口 |
| **TaskStatus** | 任务状态机：pending → in_progress → done/failed/skipped | `TaskStatus` 联合类型 |
| **Planner** | 调用 LLM 把 goal 拆成 Task[] | `Planner` / `DagPlanner` |
| **Executor** | 执行单个 task（复用 Agent 或自定义函数） | `Executor` |
| **Replanner** | task 失败后决定 continue/replan/abort | `Replanner` |
| **Task Graph (DAG)** | 有向无环图，task 间有 dependencies | `TaskGraph` |
| **Topological Sort** | 拓扑排序，按依赖顺序调度 task | `TaskGraph.detectCycle` (Kahn 算法) |
| **Beam Search** | 每步保留 top-B 候选继续扩展 | `ToTAgent.solve` |
| **Tree of Thoughts (ToT)** | 树状探索多分支，可评估剪枝 | `ToTAgent` |
| **ThoughtNode** | ToT 树节点：state + thought + score + children | `ThoughtNode` 接口 |
| **Evaluator** | 给状态打分（0-1），决定剪枝/继续 | `ToTAgent.evaluateNodes` |

## 架构设计

三种递进的 Planning 范式，复杂度递增：

```
Step 1：Plan & Execute（线性）
  Planner → [Task, Task, Task] → 顺序执行 → Replanner（失败时）→ 最终汇总

Step 2：Task Graph DAG（并行）
  DagPlanner → TaskGraph（带 dependencies）→ Scheduler（并行执行）→ 最终汇总

Step 3：Tree of Thoughts（探索式）
  ToTAgent.solve(initialState)
    └── 循环：生成 N 候选 → 评估 → 选 top-B → 继续扩展
        直到：找到解 / 达到 maxDepth / 最优分数过低
```

### 组件关系

```
src/core/planning.ts
  ├── 类型：Task, TaskStatus, Plan
  │
  ├── Step 1: 线性 Plan & Execute
  │   ├── Planner              （LLM 生成 Task[]）
  │   ├── Executor             （复用 Agent 执行 task）
  │   ├── Replanner            （失败后 continue/replan/abort）
  │   └── PlanExecuteAgent     （顶层编排）
  │
  └── Step 2: DAG Plan & Execute
      ├── TaskGraph            （DAG + 拓扑排序 + 循环检测）
      ├── DagPlanner           （LLM 生成带 dependencies 的 plan）
      ├── Scheduler            （并行调度 + skip-downstream）
      └── DagPlanExecuteAgent  （顶层编排）

src/core/tot.ts
  └── Step 3: Tree of Thoughts
      ├── ThoughtNode          （树节点）
      └── ToTAgent             （Beam Search + LLM 评估）
```

## 核心设计逻辑

### 1. 为什么 Planner / Executor / Replanner 要分开？

理论上可以合成一个 `agent.solve(goal)`，但拆开有三个好处：

- **Planner 可独立替换**：换规划策略（线性 / DAG / ToT）时，不动 Executor
- **Executor 可独立替换**：从"复用 Agent"换成"调外部 API"或"人工执行"，不动 Planner
- **Replanner 决策与执行解耦**：失败处理逻辑（是否 replan）独立于执行逻辑

这是经典的"关注点分离" —— 规划、执行、监控三个职责不应耦合。

### 2. 为什么 Replanner 提供 3 种 action 而非二选一？

```
continue: 跳过失败 task，继续剩余 plan
         适用：失败 task 独立、可绕过
replan:   重新规划剩余 task
         适用：失败 task 是后续 task 的前置
abort:    中止整个流程
         适用：失败不可恢复（如 API 不可用、关键依赖缺失）
```

二选一（continue/replan）会让 LLM 在"致命失败"时仍尝试继续，浪费 token。三选一让 LLM 能区分"可绕过"vs"必须重规划"vs"放弃"。

### 3. DAG 为什么用 skip-downstream 而非 Replanner？

Step 1 的 Replanner 在 DAG 下变得复杂：
- 替换某个 task 可能影响依赖它的 task
- DAG 中"剩余 plan"的概念不清晰（多个分支）
- LLM 决策成本高（要理解整个图）

`skip-downstream` 是确定性策略：task 失败 → 依赖它的 task 全部 skipped。简单、可预测、零 LLM 调用。

**取舍**：丧失了"失败后重新规划"的灵活性，换来了 DAG 调度的简单性。生产场景如需 replan，可在 `DagPlanExecuteAgent` 层叠加：跑完一轮后，基于失败 task 调 LLM 生成新 plan，再跑一轮。

### 4. 为什么 Scheduler 用 Promise.race 而非 Promise.all？

```ts
while (!graph.isFinished()) {
  // 启动就绪 task（最多 concurrency 个）
  for (const task of ready) { ... running.add(p); }
  // 等任一个完成，再取下一批
  await Promise.race(running);
}
```

- `Promise.all`：要等所有 running 都完成才取下一批，并发度会塌缩（如 3 个 task 同时跑，最慢的那个卡住所有人）
- `Promise.race`：任一个完成就立即取下一批就绪 task，保持并发度始终接近 `concurrency`

这是经典的"动态调度"模式 —— 任务时长不一时，吞吐量显著高于"批量等待"。

### 5. ToT 为什么用 Beam Search 而非 BFS/DFS？

```
BFS：每步扩展所有候选，节点数指数爆炸（3^5 = 243）
DFS：一条路走到黑，错过更优分支
Beam Search：每步保留 top-B（如 B=2），节点数 = B × N × depth = 2×3×5 = 30
```

Beam Search 在"探索广度"和"计算成本"间取得平衡：
- B=1：退化为贪心，可能陷入局部最优
- B=∞：退化为 BFS，成本爆炸
- B=2~3：典型值，覆盖主要分支，成本可控

### 6. ToT 的 Evaluator 为什么用 LLM 而非启发式？

- **启发式**：每个问题领域都要手写评估函数（24 点验表达式、迷宫验坐标），不可泛化
- **LLM**：通用评估，适配任意问题（创意写作、推理、规划）

代价：LLM 评估有噪声（同状态多次打分可能不同），且耗 token。生产场景可混合：有确定性评估函数时用启发式，没有时 fallback 到 LLM。

## 三个关键收获

### 1. Plan & Execute vs ReAct：全局视图 vs 局部反应

实测对比（场景 1：比较 TS 和 Rust）：

| 维度 | ReAct Agent | Plan & Execute |
|------|------------|----------------|
| 规划 | 边走边看，每步只看上一步 | 先生成 5-task plan，按计划执行 |
| 可预测性 | 同输入可能走不同路径 | plan 固定，执行可追溯 |
| 失败恢复 | 难（缺乏全局上下文） | Replanner 知道剩余 plan，决策有依据 |
| 适用场景 | 简单任务、工具调用为主 | 复杂任务、多步推理 |

**教训**：ReAct 适合"用工具查天气"这种简单任务；Plan & Execute 适合"研究 X 并对比 Y"这种需要全局规划的任务。两者不是替代关系，而是适用域不同。

### 2. DAG 并行执行的实际加速

实测（场景：研究 React + Vue 并对比）：

```
线性执行（Plan & Execute）：
  t1 → t2 → t3 → t4 → t5 → t6
  总耗时 ≈ 6 × 单 task 时长

DAG 执行（并发度 3）：
  t1 ┐
  t2 ┤  ← 并行
     ├→ t3 ┐
     ├→ t4 ┤  ← 并行
     ├→ t5 ┤
           ├→ t6
  总耗时 ≈ 3 × 单 task 时长（关键路径）
```

时间戳验证：t1 和 t2 在同一毫秒启动（`+16546ms` / `+16547ms`），t3/t4/t5 在 t2 完成后同时启动（`+20373ms`）。

**教训**：Planner 输出 dependencies 后，DAG 调度自动识别可并行 task。但前提是 Planner 能正确判断"哪些 task 真的独立" —— LLM 倾向于加多余依赖（保守起见），需要 prompt 明确要求"独立任务不要加依赖"。

### 3. ToT 的 Beam Search 在创意任务上的效果

实测（场景：写悬疑微小说）：

```
深度 1：3 候选，最高 0.55（平淡开场）
深度 2：6 候选，n8 (0.82) "她才是窗外的人" 反转潜力高
深度 3：从 n7 继续，n10 (0.80) "镜子举手" 进入下一轮
深度 4：n15 (0.85) "镜中自己挂着同样微笑" 反转完成

最终故事：午夜收信 → 窗外的脸 → 老照片 → 18 楼敲门 → 镜中微笑反转
```

总节点 19，远小于 BFS 的 3^4=81。Beam Search 剪掉了低分分支（如 n1 钥匙、n5 黑猫），保留了高分反转线。

**教训**：ToT 的关键不在"树"而在"评估函数"。评估函数差 → 剪枝剪错 → 比线性 plan 还差。LLM 评估有噪声，同状态多次打分可能不同，需要在 prompt 里明确评分维度（如"悬疑+反转+完整"）。

## 最终设计

```
src/core/planning.ts（~700 行）
  ├── 类型：Task, TaskStatus, Plan
  ├── Step 1 线性
  │   ├── Planner（LLM 生成 Task[]）
  │   ├── Executor（复用 Agent 或自定义 executeFn）
  │   ├── Replanner（continue / replan / abort 三选一）
  │   └── PlanExecuteAgent（顶层循环 + replan + 最终汇总）
  └── Step 2 DAG
      ├── TaskGraph（DAG + Kahn 拓扑排序 + skipDownstream）
      ├── DagPlanner（LLM 生成带 dependencies 的 plan）
      ├── Scheduler（Promise.race 并发调度）
      └── DagPlanExecuteAgent

src/core/tot.ts（~250 行）
  └── Step 3 ToT
      ├── ThoughtNode（树节点：state + thought + score + children）
      └── ToTAgent（Beam Search + LLM 评估 + 剪枝）

example/
  ├── 12-planning.ts       （线性：TS vs Rust 选型 + 模拟失败触发 Replanner）
  ├── 13-planning-dag.ts   （DAG：React vs Vue 研究对比，验证并行性）
  └── 14-tot.ts            （ToT：悬疑微小说创作，验证 Beam Search）
```

## 三种范式的适用场景

| 范式 | 适用场景 | 不适用场景 |
|------|---------|-----------|
| **Plan & Execute** | 目标明确、步骤线性、需要可预测执行 | 步骤间有并行机会、需要试错 |
| **DAG** | 步骤间有独立可并行的子任务 | 步骤强线性、依赖关系复杂难拆 |
| **ToT** | 解空间大、需要试错、有评估标准 | 步骤明确无需探索、评估函数难定义 |

## 遗留问题

1. **DAG 不支持 Replanner**：失败只能 skip-downstream，不能重新规划。可在 `DagPlanExecuteAgent` 层叠加"跑完一轮后基于失败 task 调 LLM 生成新 plan 再跑"的能力。

2. **ToT Evaluator 噪声**：LLM 评估同状态多次打分可能不同，影响 Beam Search 稳定性。可缓存（同 state → 同 score）或多次评估取均值。

3. **Planner 输出质量不稳定**：LLM 偶尔会生成 id 重复、dependencies 引用不存在 task 等问题。`TaskGraph.detectCycle` 会抛错，但没自动修复。可加 schema 层校验 + 重试。

4. **无持久化**：plan 和 task 状态都在内存，进程结束即丢。生产场景需把 plan + 中间结果持久化（参考 Phase 8 Workflow 的 Checkpoint）。

5. **ToT 深度上限是硬编码**：当前 `maxDepth=5` 一刀切。理想情况是"找到解就停"，但 LLM 评估分数波动可能让"接近解"的分支被剪掉。可加"分数接近阈值时降低剪枝门槛"的退火策略。
