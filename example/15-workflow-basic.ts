import {
  StateGraph,
  START,
  END,
  type WorkflowEvent,
} from "../src/core/workflow.ts";

// ─── 状态定义 ───────────────────────────────────────────────

interface CounterState {
  count: number;
  log: string[];   // 追加字段（defaultReducer 会追加而非替换）
}

// ─── 节点函数 ───────────────────────────────────────────────

const increment = (state: CounterState): Partial<CounterState> => ({
  count: state.count + 1,
  log: [`count: ${state.count} → ${state.count + 1}`],
});

const check = (state: CounterState): Partial<CounterState> => ({
  log: [`check: count=${state.count}`],
});

// ─── 构建图 ─────────────────────────────────────────────────
//
//   START → increment → check → (count < 3 ? increment : END)
//                        ↑__________|
//

const graph = new StateGraph<CounterState>()
  .addNode("increment", increment)
  .addNode("check", check)
  .addEdge(START, "increment")
  .addEdge("increment", "check")
  .addConditionalEdge("check", (state) =>
    state.count < 3 ? "increment" : END,
  );

const app = graph.compile();

// ─── 执行 + 事件追踪 ────────────────────────────────────────

console.log("=== Workflow 基础执行（计数器循环）===\n");

const result = await app.invoke(
  { count: 0, log: [] },
  {
    onEvent: (event: WorkflowEvent<CounterState>) => {
      const e = event as { type: string; node?: string; from?: string; to?: string };
      if (e.type === "node_start") {
        console.log(`  ▶ ${e.node}`);
      } else if (e.type === "edge") {
        console.log(`    ${e.from} → ${e.to}`);
      } else if (e.type === "finish") {
        console.log(`  ✓ 完成`);
      }
    },
  },
);

console.log(`\n最终 count: ${result.count}`);
console.log(`执行日志 (${result.log.length} 条):`);
result.log.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));

// ─── 验证 maxIterations 保护 ────────────────────────────────

console.log("\n=== 验证 maxIterations 保护（死循环）===\n");

const infiniteGraph = new StateGraph<CounterState>()
  .addNode("loop", (s) => ({ count: s.count + 1 }))
  .addEdge(START, "loop")
  .addEdge("loop", "loop");  // 永远回自己

const infiniteApp = infiniteGraph.compile({ maxIterations: 5 });

try {
  await infiniteApp.invoke({ count: 0, log: [] });
  console.log("未抛错（不符合预期）");
} catch (e) {
  console.log(`✓ 正确抛错: ${e instanceof Error ? e.message : e}`);
}

// ─── 验证 compile 期校验 ────────────────────────────────────

console.log("\n=== 验证 compile 期校验 ===\n");

// 1. 节点无出边
try {
  new StateGraph<CounterState>()
    .addNode("a", () => ({}))
    .addEdge(START, "a")
    .compile();
  console.log("无出边: 未抛错（不符合预期）");
} catch (e) {
  console.log(`✓ 无出边校验: ${e instanceof Error ? e.message : e}`);
}

// 2. 边指向不存在的节点
try {
  new StateGraph<CounterState>()
    .addNode("a", () => ({}))
    .addEdge(START, "a")
    .addEdge("a", "nonexistent")
    .compile();
  console.log("指向不存在: 未抛错（不符合预期）");
} catch (e) {
  console.log(`✓ 指向不存在校验: ${e instanceof Error ? e.message : e}`);
}

// 3. 同节点同时有普通边和条件边
try {
  new StateGraph<CounterState>()
    .addNode("a", () => ({}))
    .addEdge(START, "a")
    .addEdge("a", END)
    .addConditionalEdge("a", () => END);
  console.log("边冲突: 未抛错（不符合预期）");
} catch (e) {
  console.log(`✓ 边冲突校验: ${e instanceof Error ? e.message : e}`);
}
