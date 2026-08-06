import { rmSync, existsSync } from "node:fs";
import {
  StateGraph,
  START,
  END,
  MemorySaver,
  FileSaver,
  type Checkpoint,
} from "../src/core/workflow.ts";

// ─── 状态定义 ───────────────────────────────────────────────

interface CounterState {
  count: number;
  log: string[];
}

// ─── 图定义：数到 5 ────────────────────────────────────────
//
//   START → increment → check → (count < 5 ? increment : END)

let nodeCallCount = 0;  // 追踪 increment 被调用了几次

const graph = new StateGraph<CounterState>()
  .addNode("increment", (s) => {
    nodeCallCount++;
    return { count: s.count + 1, log: [`increment #${nodeCallCount}: ${s.count}→${s.count + 1}`] };
  })
  .addNode("check", (s) => ({
    log: [`check: count=${s.count}`],
  }))
  .addEdge(START, "increment")
  .addEdge("increment", "check")
  .addConditionalEdge("check", (s) => (s.count < 5 ? "increment" : END));

const app = graph.compile({ maxIterations: 20 });

// ─── 场景 1：MemorySaver 中断恢复 ──────────────────────────

console.log("=== 场景 1：MemorySaver 中断恢复 ===\n");

const memory = new MemorySaver<CounterState>();

// 第一次执行：用 maxIterations=6 模拟中断（跑到 count=3 时超限抛错）
// checkpoint 会在每次节点执行后保存，所以错误前最后一次状态已持久化
console.log("[第一次执行] 限制 maxIterations=6，模拟中断");
try {
  await app.invoke(
    { count: 0, log: [] },
    { checkpointSaver: memory, threadId: "t1", maxIterations: 6 },
  );
  console.log("  未抛错（不符合预期）");
} catch (e) {
  console.log(`  ✓ 预期抛错: ${e instanceof Error ? e.message : e}`);
}
console.log(`  increment 调用次数: ${nodeCallCount}`);

const cp1 = await memory.load("t1");
console.log(`  Checkpoint: count=${cp1?.state.count}, currentNode=${cp1?.currentNode}, iteration=${cp1?.iteration}\n`);

// 第二次执行：从 checkpoint 恢复，继续跑到 END
console.log("[第二次执行] 从 checkpoint 恢复，继续到 END");
const beforeCall = nodeCallCount;
const r2 = await app.invoke(
  { count: 0, log: [] },  // 初始 state 会被 checkpoint 覆盖
  { checkpointSaver: memory, threadId: "t1" },
);
console.log(`  结果: count=${r2.count}, 日志 ${r2.log.length} 条`);
console.log(`  本次新增 increment 调用: ${nodeCallCount - beforeCall}（从 ${beforeCall} → ${nodeCallCount}）`);
console.log(`  最终日志:`);
r2.log.forEach((line, i) => console.log(`    ${i + 1}. ${line}`));

// ─── 场景 2：FileSaver 跨进程持久化 ────────────────────────

console.log("\n=== 场景 2：FileSaver 跨进程持久化 ===\n");

const dir = "/tmp/workflow-checkpoints";
rmSync(dir, { recursive: true, force: true });

const fileSaver = new FileSaver<CounterState>(dir);

// 第一次执行：跑到一半中断
console.log("[第一次执行] 限制 maxIterations=4，写入文件");
nodeCallCount = 0;
try {
  await app.invoke(
    { count: 0, log: [] },
    { checkpointSaver: fileSaver, threadId: "session-abc", maxIterations: 4 },
  );
  console.log("  未抛错（不符合预期）");
} catch (e) {
  console.log(`  ✓ 预期抛错: ${e instanceof Error ? e.message : e}`);
}
console.log(`  文件存在: ${existsSync(`${dir}/session-abc.json`)}`);

// 读取文件内容验证
const cp2 = await fileSaver.load("session-abc");
console.log(`  文件内容: currentNode=${cp2?.currentNode}, iteration=${cp2?.iteration}, count=${cp2?.state.count}`);

// 第二次执行：从文件恢复（模拟新进程）
console.log("\n[第二次执行] 模拟新进程，从文件恢复");
const beforeCall2 = nodeCallCount;
const r4 = await app.invoke(
  { count: 999, log: ["这应该被覆盖"] },  // 故意传错误的初始值
  { checkpointSaver: fileSaver, threadId: "session-abc" },
);
console.log(`  结果: count=${r4.count}`);
console.log(`  本次新增 increment 调用: ${nodeCallCount - beforeCall2}`);
console.log(`  初始值被覆盖: ${!r4.log.includes("这应该被覆盖")}`);

// ─── 场景 3：resume=false 强制从头开始 ─────────────────────

console.log("\n=== 场景 3：resume=false 强制从头开始 ===\n");

nodeCallCount = 0;
console.log("[执行] 同一 threadId，但 resume=false");
const r5 = await app.invoke(
  { count: 0, log: [] },
  {
    checkpointSaver: fileSaver,
    threadId: "session-abc",
    resume: false,  // 忽略已有 checkpoint
    maxIterations: 20,
  },
);
console.log(`  结果: count=${r5.count}（应该从 0 重新数到 5）`);
console.log(`  increment 调用次数: ${nodeCallCount}（应该 5）`);

// ─── 场景 4：list / clear ──────────────────────────────────

console.log("\n=== 场景 4：list / clear ===\n");

await fileSaver.save({ threadId: "a", state: { count: 1, log: [] }, currentNode: "x", iteration: 1, timestamp: 1 });
await fileSaver.save({ threadId: "b", state: { count: 2, log: [] }, currentNode: "y", iteration: 2, timestamp: 2 });

const all = await fileSaver.list();
console.log(`list: ${all.length} 个快照（threads: ${all.map((c) => c.threadId).sort().join(", ")}）`);

await fileSaver.clear("a");
const afterClear = await fileSaver.list();
console.log(`clear("a") 后: ${afterClear.length} 个快照（threads: ${afterClear.map((c) => c.threadId).sort().join(", ")}）`);

// 清理
rmSync(dir, { recursive: true, force: true });
console.log("\n清理完成");
